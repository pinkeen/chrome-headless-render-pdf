const CDP = require('chrome-remote-interface');
const fs = require('fs');
const cp = require('child_process');
const net = require('net');
const commandExists = require('command-exists');
const _ = require('lodash');

class StreamReader {
    constructor(stream) {
        this.data = '';
        stream.on('data', (chunk) => {
            this.data += chunk.toString();
        });
    }
}

class RenderPDF {
    constructor(options) {
        this.setOptions(options || {});
        this.chrome = null;

        if (this.options.remoteHost) {
          this.host = this.options.remoteHost;
          this.port = this.options.remotePort;
        } else {
          this.host = 'localhost';
        }
    }

    selectFreePort() {
        return new Promise((resolve) => {
            let port = Math.floor(Math.random() * 30000) + 30000;
            const server = net.createServer({allowHalfOpen: true});
            server.on('listening', () => {
                server.close(() => {
                    resolve(port);
                });
            });
            server.on('error', () => {
                server.listen(Math.floor(Math.random() * 30000) + 30000);
            });
            server.listen(port);
        })
    }

    setOptions(options) {
        this.options = {
            printLogs: def('printLogs', false),
            printErrors: def('printErrors', true),
            chromeBinary: def('chromeBinary', null),
            chromeOptions: def('chromeOptions', []),
            remoteHost: def('remoteHost', null),
            remotePort: def('remotePort', 9222),
            noMargins: def('noMargins', false),
            landscape: def('landscape', undefined),
            paperWidth: def('paperWidth', undefined),
            paperHeight: def('paperHeight', undefined),
            includeBackground: def('includeBackground', undefined),
            pageRanges: def('pageRanges', undefined),
            scale: def('scale', undefined),
            format: def('format', 'pdf')
        };

        this.commandLineOptions = {
            windowSize: def('windowSize', undefined),
        };

        function def(key, defaultValue) {
            return options[key] === undefined ? defaultValue : options[key];
        }
    }

    static async generateSingle(url, filename, options) {
        const renderer = new RenderPDF(options);
        await renderer.connectToChrome();
        try {
            const buff = await renderer.render(url, renderer.generateOptions());
            fs.writeFileSync(filename, buff);
            renderer.log(`Saved ${filename}`);
        } catch (e) {
            renderer.error('error:', e);
        }
        renderer.killChrome();
    }

    static async generateBuffer(url, options) {
        const renderer = new RenderPDF(options);
        await renderer.connectToChrome();
        try {
            return await renderer.renderPdf(url, renderer.generatePdfOptions());
        } catch (e) {
            renderer.error('error:', e);
        } finally {
            renderer.killChrome();
        }
    }

    static async generateMultiple(pairs, options) {
        const renderer = new RenderPDF(options);
        await renderer.connectToChrome();
        for (const job of pairs) {
            try {
                const buff = await renderer.render(job.url, renderer.generateOptions());
                fs.writeFileSync(job.pdf, buff);
                renderer.log(`Saved ${job.pdf}`);
            } catch (e) {
                renderer.error('error:', e);
            }
        }
        renderer.killChrome();
    }

    async renderPdf(url, options) {
        return new Promise((resolve, reject) => {
            CDP({host: this.host, port: this.port}, async (client) => {
                try{
                    this.log(`Opening ${url}`);
                    const {Page, Emulation, LayerTree} = client;
                    await Page.enable();
                    await LayerTree.enable();

                    const loaded = this.cbToPromise(Page.loadEventFired);
                    const jsDone = this.cbToPromise(Emulation.virtualTimeBudgetExpired);

                    await Page.navigate({url});
                    await Emulation.setVirtualTimePolicy({policy: 'pauseIfNetworkFetchesPending', budget: 5000});

                    await this.profileScope('Wait for load', async () => {
                        await loaded;
                    });

                    await this.profileScope('Wait for js execution', async () => {
                        await jsDone;
                    });

                    await this.profileScope('Wait for animations', async () => {
                        await new Promise((resolve) => {
                            setTimeout(resolve, 5000); // max waiting time
                            let timeout = setTimeout(resolve, 100);
                            LayerTree.layerPainted(() => {
                                clearTimeout(timeout);
                                timeout = setTimeout(resolve, 100);
                            });
                        });
                    });

                    let out;
                    if (options.format === 'pdf') {
                        out = await Page.printToPDF(options);
                    } else {
                        out = await Page.captureScreenshot(_.pick(options, ['format']));
                    }

                    const buff = Buffer.from(out.data, 'base64');

                    client.close();
                    resolve(buff);

                } catch (e) {
                    reject(e.message)
                }
            });
        });
    }

    generateOptions() {
        const options = {};
        if (this.options.landscape !== undefined) {
            options.landscape = !!this.options.landscape;
        }

        if (this.options.noMargins) {
            options.marginTop = 0;
            options.marginBottom = 0;
            options.marginLeft = 0;
            options.marginRight = 0;
        }

        if (this.options.includeBackground !== undefined) {
            options.printBackground = !!this.options.includeBackground;
        }
        
        options.format = this.options.format;

        if(this.options.paperWidth !== undefined) {
            options.paperWidth = parseFloat(this.options.paperWidth);
        }

        if(this.options.paperHeight !== undefined) {
            options.paperHeight = parseFloat(this.options.paperHeight);
        }

        if(this.options.pageRanges !== undefined) {
            options.pageRanges = this.options.pageRanges;
        }

        if(this.options.scale !== undefined) {
            let scale = this.options.scale;
            if(scale < 0.1) {
                console.warn(`scale cannot be lower than 0.1, using 0.1`);
                scale = 0.1;
            }
            if(scale > 2) {
                console.warn(`scale cannot be higher than 2, using 2`);
                scale = 2;
            }
            options.scale = scale;
        }

        return options;
    }

    error(...msg) {
        if (this.options.printErrors) {
            console.error(...msg);
        }
    }

    log(...msg) {
        if (this.options.printLogs) {
            console.log(...msg);
        }
    }

    async cbToPromise(cb) {
        return new Promise((resolve) => {
            cb((resp) => {
                resolve(resp);
            })
        });
    }

    getPerfTime(prev) {
        const time = process.hrtime(prev);
        return time[0] * 1e3 + time[1] / 1e6;
    }

    async profileScope(msg, cb) {
        const start = process.hrtime();
        await cb();
        this.log(msg, `took ${Math.round(this.getPerfTime(start))}ms`);
    }

    browserLog(type, msg) {
        const lines = msg.split('\n');
        for (const line of lines) {
            this.log(`(chrome) (${type}) ${line}`);
        }
    }

    async spawnChrome() {
        if(!this.port) {
            this.port = await this.selectFreePort();
        }
        const chromeExec = this.options.chromeBinary || await this.detectChrome();
        this.log('Using', chromeExec);
        const commandLineOptions = [
             '--headless',
             `--remote-debugging-port=${this.port}`,
             '--disable-gpu',
             ...this.options.chromeOptions
            ];

        if (this.commandLineOptions.windowSize !== undefined ) {
          commandLineOptions.push(`--window-size=${this.commandLineOptions.windowSize[0]},${this.commandLineOptions.windowSize[1]}`);

        }
        this.chrome = cp.spawn(
            chromeExec,
            commandLineOptions
        );
        const stdout = new StreamReader(this.chrome.stdout);
        const stderr = new StreamReader(this.chrome.stderr);
        this.chrome.on('close', (code) => {
            this.log(`Chrome stopped (${code})`);
            this.browserLog('out', stdout.data);
            this.browserLog('err', stderr.data);
        });
    }

    async connectToChrome() {
      if (!this.options.remoteHost) {
        await this.spawnChrome();
      }

      await this.waitForDebugPort();
    }

    async isCommandExists(cmd) {
        return new Promise((resolve, reject) => {
            commandExists(cmd, (err, exists) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(exists);
                }
            })
        });
    }

    async detectChrome() {
        if (await this.isCommandExists('google-chrome-unstable')) {
            return 'google-chrome-unstable';
        }
        if (await this.isCommandExists('google-chrome-beta')) {
            return 'google-chrome-beta';
        }
        if (await this.isCommandExists('google-chrome-stable')) {
            return 'google-chrome-stable';
        }
        if (await this.isCommandExists('google-chrome')) {
            return 'google-chrome';
        }
        if (await this.isCommandExists('chromium')) {
            return 'chromium';
        }
        if (await this.isCommandExists('chromium-browser')) {
            return 'chromium-browser';
        }
        // windows
        if (await this.isCommandExists('chrome')) {
            return 'chrome';
        }
        // macos
        if (await this.isCommandExists('/Applications/Google\ Chrome\ Canary.app/Contents/MacOS/Google\ Chrome')) {
            return '/Applications/Google\ Chrome\ Canary.app/Contents/MacOS/Google\ Chrome';
        }
        if (await this.isCommandExists('/Applications/Google\ Chrome\ Dev.app/Contents/MacOS/Google\ Chrome')) {
            return '/Applications/Google\ Chrome\ Dev.app/Contents/MacOS/Google\ Chrome';
        }
        if (await this.isCommandExists('/Applications/Google\ Chrome\ Beta.app/Contents/MacOS/Google\ Chrome')) {
            return '/Applications/Google\ Chrome\ Beta.app/Contents/MacOS/Google\ Chrome';
        }
        if (await this.isCommandExists('/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome')) {
            return '/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome';
        }
        throw Error('Couldn\'t detect chrome version installed! use --chrome-binary to pass custom location');
    }

    killChrome() {
        if (!this.options.remoteHost) {
            this.chrome.kill(cp.SIGKILL);
        }
    }

    async waitForDebugPort() {
        this.log('Waiting for chrome to became available');
        while (true) {
            try {
                await this.isPortOpen(this.host, this.port);
                this.log('Chrome port open!');
                await this.checkChromeVersion();
                return;
            } catch (e) {
                await this.wait(10);
            }
        }
    }

    async checkChromeVersion() {
        return new Promise((resolve, reject) => {
            CDP({host: this.host, port: this.port}, async (client) => {
                try {
                    const {Browser} = client;
                    const version = await Browser.getVersion();
                    if(version.product.search('/64.') !== -1) {
                        this.error('     ===== WARNING =====');
                        this.error('  Detected Chrome in version 64.x');
                        this.error('  This version is known to contain bug in remote api that prevents this tool to work');
                        this.error('  This issue is resolved in version 65');
                        this.error('  More info: https://github.com/Szpadel/chrome-headless-render-pdf/issues/22');
                    }
                    this.log(`Connected to ${version.product}, protocol ${version.protocolVersion}`);
                }catch (e) {
                    this.error(`Wasn't able to check chrome version, skipping compatibility check.`);
                }
                resolve();
            }).on('error', e => { reject(e) });
        });
    }

    async isPortOpen(host, port) {
        return new Promise(function (resolve, reject) {
            const connection = new net.Socket();
            connection.connect({host, port});
            connection.on('connect', () => {
                connection.end();
                resolve();
            });
            connection.on('error', () => {
                reject();
            })
        });
    }

    async wait(ms) {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }
}

module.exports = RenderPDF;
module.exports.default = RenderPDF;
