/**
 * @license Copyright 2019 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/** @typedef {import('../driver.js')} Driver */

const log = require('lighthouse-logger');
const Gatherer = require('./gatherer.js');
const URL = require('../../lib/url-shim.js');

/**
 * This function is careful not to parse the response as JSON, as it will
 * just need to be serialized again over the protocol, and source maps can
 * be huge.
 *
 * @param {string} url
 * @return {Promise<string|{errorMessage: string}>}
 */
/* istanbul ignore next */
async function fetchSourceMap(url) {
  try {
    // eslint-disable-next-line no-undef
    const response = await fetch(url);
    return response.text();
  } catch (err) {
    return {errorMessage: err.toString()};
  }
}

/**
 * @fileoverview Gets JavaScript source maps.
 */
class SourceMaps extends Gatherer {
  constructor() {
    super();
    /** @type {LH.Crdp.Debugger.ScriptParsedEvent[]} */
    this._scriptParsedEvents = [];
    this.onScriptParsed = this.onScriptParsed.bind(this);
  }

  /**
   * @param {Driver} driver
   * @param {string} sourceMapUrl
   * @return {Promise<{map: LH.Artifacts.RawSourceMap} | {errorMessage: string}>}
   */
  async fetchSourceMapInPage(driver, sourceMapUrl) {
    driver.setNextProtocolTimeout(1000);
    /** @type {string|{errorMessage: string}} */
    const sourceMapJsonOrError =
      await driver.evaluateAsync(`(${fetchSourceMap})(${JSON.stringify(sourceMapUrl)})`);

    // If object, then an error occurred.
    if (typeof sourceMapJsonOrError === 'object') {
      return sourceMapJsonOrError;
    }

    // Map was returned as JSON. See `fetchSourceMap` for why.
    return {map: JSON.parse(sourceMapJsonOrError)};
  }

  /**
   * @param {string} sourceMapURL
   * @return {{map: LH.Artifacts.RawSourceMap}}
   */
  parseSourceMapFromDataUrl(sourceMapURL) {
    const buffer = Buffer.from(sourceMapURL.split(',')[1], 'base64');
    return {
      map: JSON.parse(buffer.toString()),
    };
  }

  /**
   * @param {LH.Crdp.Debugger.ScriptParsedEvent} event
   */
  onScriptParsed(event) {
    if (event.sourceMapURL) {
      this._scriptParsedEvents.push(event);
    }
  }

  /**
   * @param {LH.Gatherer.PassContext} passContext
   */
  async beforePass(passContext) {
    const driver = passContext.driver;
    driver.on('Debugger.scriptParsed', this.onScriptParsed);
    await driver.sendCommand('Debugger.enable');
  }

  /**
   * @param {string} url
   * @param {string} base
   */
  _resolveUrl(url, base) {
    try {
      return new URL(url, base).href;
    } catch (e) {
      return url;
    }
  }

  /**
   * @param {LH.Gatherer.PassContext} passContext
   * @return {Promise<LH.Artifacts['SourceMaps']>}
   */
  async afterPass(passContext) {
    const driver = passContext.driver;

    driver.off('Debugger.scriptParsed', this.onScriptParsed);
    await driver.sendCommand('Debugger.disable');

    /** @type {LH.Artifacts.SourceMap[]} */
    const sourceMaps = [];
    for (const event of this._scriptParsedEvents) {
      if (!event.sourceMapURL) continue;

      // `sourceMapURL` is simply the URL found in either a magic comment or an x-sourcemap header.
      // It has not been resolved to a base url.
      const sourceMapURL = event.sourceMapURL.startsWith('data:') ?
        event.sourceMapURL :
        this._resolveUrl(event.sourceMapURL, event.url);

      log.log('SourceMaps', event.url, sourceMapURL.startsWith('data:') ? 'data:...' : sourceMapURL);
      let sourceMapOrError;
      try {
        sourceMapOrError = sourceMapURL.startsWith('data:') ?
          this.parseSourceMapFromDataUrl(sourceMapURL) :
          await this.fetchSourceMapInPage(driver, sourceMapURL);
      } catch (err) {
        log.log('SourceMaps', event.url, err.toString());
        sourceMapOrError = {errorMessage: err.toString()};
      }

      sourceMaps.push({
        scriptUrl: event.url,
        ...sourceMapOrError,
      });
    }

    return sourceMaps;
  }
}

module.exports = SourceMaps;