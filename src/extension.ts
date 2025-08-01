import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { https } from 'follow-redirects';
import { promisify } from 'util';
import { exec } from 'child_process';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient/node';

const execAsync = promisify(exec);

let client: LanguageClient;

interface GitHubRelease {
    tag_name: string;
    assets: Array<{
        name: string;
        browser_download_url: string;
    }>;
}

async function getLatestRelease(): Promise<GitHubRelease> {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: '/repos/koto-lang/koto-ls/releases/latest',
            headers: {
                'User-Agent': 'koto-vscode-extension'
            }
        };

        https.get(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (error) {
                    reject(error);
                }
            });
        }).on('error', reject);
    });
}

async function downloadFile(url: string, filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: new URL(url).hostname,
            path: new URL(url).pathname,
            headers: {
                'User-Agent': 'koto-vscode-extension'
            }
        };

        const file = fs.createWriteStream(filePath);
        const request = https.request(options, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(filePath, () => { }); // Delete the file on error
            reject(err);
        });

        request.end();
    });
}

function getPlatformBinaryName(): string {
    const platform = process.platform;
    const arch = process.arch;
    const key = platform + '-' + arch;
    const binaryNames: { [key: string]: string } = {
        'win32-x64': 'koto-ls-x86_64-pc-windows-msvc.zip',
        'darwin-arm64': 'koto-ls-aarch64-apple-darwin.tar.gz',
        'darwin-x64': 'koto-ls-x86_64-apple-darwin.tar.gz',
        'linux-x64': 'koto-ls-x86_64-unknown-linux-gnu.tar.gz'
    }

    const binaryName = binaryNames[key];
    if (binaryName)
        return binaryName;

    throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

async function extractArchive(archivePath: string, extractDir: string): Promise<string> {
    const isZip = archivePath.endsWith('.zip');
    const isTarGz = archivePath.endsWith('.tar.gz');

    if (!isZip && !isTarGz) throw new Error(`Unsupported archive format: ${archivePath}`);

    if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });

    const command = (process.platform === 'win32' && isZip)
        ? `powershell -command "Expand-Archive -Path '${archivePath}' -DestinationPath '${extractDir}' -Force"`
        : isTarGz ? `tar -xzf "${archivePath}" -C "${extractDir}"`
            : null;

    if (!command) throw new Error(`Cannot extract ${archivePath} on ${process.platform}`);
    await execAsync(command);

    const expectedBinaryName = 'koto-ls' + (process.platform === 'win32' ? '.exe' : '');
    const findBinary = (dir: string): string | null => {
        for (const item of fs.readdirSync(dir)) {
            const itemPath = path.join(dir, item);
            const stat = fs.statSync(itemPath);
            if (stat.isFile() && item === expectedBinaryName) return itemPath;
            if (stat.isDirectory()) {
                const found = findBinary(itemPath);
                if (found) return found;
            }
        }
        return null;
    };

    const binaryPath = findBinary(extractDir);
    if (!binaryPath) throw new Error(`Could not find ${expectedBinaryName} in extracted archive`);
    return binaryPath;
}

async function getStoredVersion(versionFilePath: string): Promise<string | null> {
    try {
        return fs.existsSync(versionFilePath) ? fs.readFileSync(versionFilePath, 'utf8').trim() : null;
    } catch {
        return null;
    }
}

async function isValidBinary(binaryPath: string): Promise<boolean> {
    return fs.existsSync(binaryPath);
}

async function downloadAndExtract(context: vscode.ExtensionContext, release: GitHubRelease, progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
    const binaryName = getPlatformBinaryName();
    const asset = release.assets.find(a => a.name === binaryName);

    if (!asset) {
        throw new Error(`No binary found, expecting: ${binaryName}`);
    }

    const storageDir = context.globalStorageUri.fsPath;
    const archivePath = path.join(storageDir, binaryName);
    const extractDir = path.join(storageDir, 'extracted');
    const extensionBinaryPath = getBinaryPath(context);

    // Ensure storage directory exists
    if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
    }

    // Download and extract
    progress?.report({ message: 'Downloading binary...', increment: 20 });
    await downloadFile(asset.browser_download_url, archivePath);

    progress?.report({ message: 'Extracting archive...', increment: 30 });
    const extractedBinaryPath = await extractArchive(archivePath, extractDir);

    // Install binary
    progress?.report({ message: 'Installing binary...', increment: 30 });
    fs.copyFileSync(extractedBinaryPath, extensionBinaryPath);
    if (process.platform !== 'win32') {
        fs.chmodSync(extensionBinaryPath, '755');
    }

    // Store version and cleanup
    progress?.report({ message: 'Cleaning up...', increment: 20 });
    fs.writeFileSync(path.join(storageDir, 'version.txt'), release.tag_name);
    fs.unlinkSync(archivePath);
    fs.rmSync(extractDir, { recursive: true, force: true });
}

async function ensureKotoLs(context: vscode.ExtensionContext, serverPath: string): Promise<string> {
    const extensionBinaryPath = getBinaryPath(context);

    // skip if user use a custom path for koto-ls
    if (serverPath) {
        return serverPath;
    }

    const versionFilePath = path.join(context.globalStorageUri.fsPath, 'version.txt');

    const currentVersion = await getStoredVersion(versionFilePath);
    const release = await getLatestRelease();

    // Check if current installation is up to date
    if (currentVersion && await isValidBinary(extensionBinaryPath)) {
        if (currentVersion === release.tag_name) {
            return extensionBinaryPath;
        }

        // Update with progress
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Updating Koto-ls ${currentVersion} to ${release.tag_name}`,
            cancellable: false
        }, async (progress) => {
            try {
                await downloadAndExtract(context, release, progress);
                vscode.window.showInformationMessage(`Koto-ls has been updated to ${release.tag_name} successfully!`);
                return extensionBinaryPath;
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to update Koto-ls: ${error}`);
                throw error;
            }
        });
    } else {
        // Download with progress
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Installing koto-ls',
            cancellable: false
        }, async (progress) => {
            try {
                await downloadAndExtract(context, release, progress);
                vscode.window.showInformationMessage(`Koto-ls ${release.tag_name} has been installed successfully!`);
                return extensionBinaryPath;
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to install Koto-ls: ${error}`);
                throw error;
            }
        });
    }
}

function getBinaryPath(context: vscode.ExtensionContext): string {
    return path.join(context.globalStorageUri.fsPath, 'koto-ls' + (process.platform === 'win32' ? '.exe' : ''));
}

export async function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('koto');
    let configuredServerPath = config.get<string>('server.path', '');
    const serverArgs = config.get<string[]>('server.args', []);

    try {
        const serverPath = await ensureKotoLs(context, configuredServerPath);
        const serverOptions: ServerOptions = {
            run: {
                command: serverPath,
                args: serverArgs,
                transport: TransportKind.stdio,
            },
            debug: {
                command: serverPath,
                args: serverArgs,
                transport: TransportKind.stdio,
            }
        };

        const clientOptions: LanguageClientOptions = {
            documentSelector: [
                { scheme: 'file', language: 'koto' }
            ],
            synchronize: {
                fileEvents: vscode.workspace.createFileSystemWatcher('**/*.koto')
            },
        };

        client = new LanguageClient(
            'koto-language-server',
            'Koto Language Server',
            serverOptions,
            clientOptions
        );

        client.start();
        context.subscriptions.push(client);

        context.subscriptions.push(
            vscode.commands.registerCommand('koto.restartServer', async () => {
                if (!client) return;
                try {
                    await client.stop();
                    await client.start();
                    vscode.window.showInformationMessage('Koto-ls restarted');
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to restart Koto-ls: ${error}`);
                }
            }),
        );
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to start Koto-ls: ${error}`);
    }
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }

    return client.stop();
}
