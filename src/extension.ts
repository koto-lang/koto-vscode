import * as vscode from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('koto');
    const serverPath = config.get<string>('server.path', 'koto-ls');
    const serverArgs = config.get<string[]>('server.args', []);

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
            if (client) {
                try {
                    await client.stop();
                    await client.start();
                    vscode.window.showInformationMessage('Koto Language Server restarted');
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to restart server: ${error}`);
                }
            }
        })
    );
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }

    return client.stop();
}
