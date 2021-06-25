// This file is part of CycloneDX GitHub Action for Go Modules
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an “AS IS” BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) Niklas Düster. All Rights Reserved.

const core = require('@actions/core');
const exec = require('@actions/exec');
const fs = require('fs');
const http = require('@actions/http-client');
const io = require('@actions/io');
const os = require('os');
const path = require('path');
const semver = require('semver');
const toolCache = require('@actions/tool-cache');
const util = require('util');

const input = {
    includeStdLib: core.getBooleanInput('include-stdlib'),
    includeTest: core.getBooleanInput('include-test'),
    json: core.getBooleanInput('json'),
    module: core.getInput('module'),
    omitSerialNumber: core.getBooleanInput('omit-serial-number'),
    omitVersionPrefix: core.getBooleanInput('omit-version-prefix'),
    output: core.getInput('output') || '-',
    reproducible: core.getBooleanInput('reproducible'),
    resolveLicenses: core.getBooleanInput('resolve-licenses'),
    type: core.getInput('type') || 'application',
    version: core.getInput('version'),
};

const baseDownloadUrl = 'https://github.com/CycloneDX/cyclonedx-gomod/releases/download';
const minimumSupportedVersion = 'v0.8.1';

function buildDownloadUrl(version) {
    let fileExtension = "tar.gz";

    let platform = os.platform().toString();
    if (platform === 'win32') {
        platform = 'windows';
        fileExtension = 'zip';
    }

    let architecture = os.arch()
    if (architecture === 'ia32' || architecture === 'x32') {
        architecture = 'x86';
    }

    return `${baseDownloadUrl}/v${version}/cyclonedx-gomod_${version}_${platform}_${architecture}.${fileExtension}`;
}

async function getLatestReleaseVersion(httpClient) {
    core.info('Determining latest release version of cyclonedx-gomod');
    const responseJson = await httpClient.getJson('https://api.github.com/repos/CycloneDX/cyclonedx-gomod/releases/latest');
    if (responseJson === null) { // HTTP 404
        throw new Error('Fetching latest release of cyclonedx-gomod failed: not found');
    } else if (responseJson.statusCode !== 200) {
        throw new Error(`Unexpected response status: ${responseJson.statusCode}`);
    }

    return responseJson.result.tag_name;
}

async function getReleaseVersionMatchingRange(httpClient, range) {
    core.info(`Determining latest release version of cyclonedx-gomod satisfying "${range}"`);
    const responseJson = await httpClient.getJson('https://api.github.com/repos/CycloneDX/cyclonedx-gomod/releases');
    if (responseJson === null) { // HTTP 404
        throw new Error('Fetching latest release of cyclonedx-gomod failed: not found');
    } else if (responseJson.statusCode !== 200) {
        throw new Error(`Unexpected response status: ${responseJson.statusCode}`);
    }

    const matched = semver.maxSatisfying(responseJson.result.map((release) => release.tag_name), range);
    core.info(`Latest release version matching "${range}" is: ${matched}`);
    return matched;
}

async function install(version) {
    core.info(`Installing cyclonedx-gomod ${version}`);
    const downloadUrl = buildDownloadUrl(version);

    core.info(`Downloading ${downloadUrl}`);
    const archivePath = await toolCache.downloadTool(downloadUrl);

    core.info('Extracting archive');
    let installDir = "";
    if (downloadUrl.endsWith('.zip')) {
        installDir = await toolCache.extractZip(archivePath, process.env.HOME);
    } else {
        installDir = await toolCache.extractTar(archivePath, process.env.HOME);
    }

    return path.join(installDir, 'cyclonedx-gomod');
}

async function run() {
    const httpClient = new http.HttpClient('gh-gomod-generate-sbom');

    try {
        // Make sure Go is in $PATH, throw if it isn't
        await io.which('go', true);

        let versionToInstall = input.version;
        if (versionToInstall.toLowerCase() === 'latest') {
            core.warning('Using version "latest" is not recommended, please use version ranges instead!');
            versionToInstall = await getLatestReleaseVersion(httpClient);
        } else {
            if (!semver.validRange(versionToInstall)) {
                throw new Error('version must be a valid version range, see https://github.com/npm/node-semver#advanced-range-syntax')
            }

            versionToInstall = await getReleaseVersionMatchingRange(httpClient, versionToInstall);

            if (semver.lt(versionToInstall, minimumSupportedVersion)) {
                throw new Error(`cyclonedx-gomod versions below ${minimumSupportedVersion} are not supported`);
            }
        }

        const binaryPath = await install(versionToInstall.replace(/^v/, ''));

        // Assemble cyclonedx-gomod arguments
        let args = ['-output', input.output, '-type', input.type];
        if (input.includeStdLib) {
            args.push('-std');
        }
        if (input.includeTest) {
            args.push('-test');
        }
        if (input.json) {
            args.push('-json');
        }
        if (input.module !== '') {
            args.push('-module', input.module);
        }
        if (input.omitSerialNumber) {
            args.push('-noserial');
        }
        if (input.omitVersionPrefix) {
            args.push('-novprefix');
        }
        if (input.reproducible) {
            args.push('-reproducible');
        }
        if (input.resolveLicenses) {
            args.push('-licenses');
        }

        await exec.exec(binaryPath, args);

        if (input.output !== '-') {
            const readFile = util.promisify(fs.readFile);
            const sbomContent = await readFile(input.output);
            core.info(`SBOM content:\n${sbomContent.toString('utf-8')}`);
        }
    } catch (error) {
        core.setFailed(error.message);
    }
}

run();
