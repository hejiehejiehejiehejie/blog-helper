import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';      // <-- 【新增】用于检查文件是否存在
import * as path from 'path';  // <-- 【新增】用于拼接文件路径
const outputChannel = vscode.window.createOutputChannel('Blog Helper');

// 辅助函数：用来在后台执行终端命令，并记录日志
function runCommand(command: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        // 1. 记录开始执行的命令
        outputChannel.appendLine(`\n>>> [执行命令]: ${command}`);
        
        exec(command, { cwd }, (error: any, stdout: string, stderr: string) => {
            // 2. 把标准输出和错误输出都原封不动地打到控制台里
            if (stdout) {
                outputChannel.appendLine(`[输出]:\n${stdout.trim()}`);
            }
            if (stderr) {
                outputChannel.appendLine(`[系统提示/错误]:\n${stderr.trim()}`);
            }

            // 3. 判断是否真正的执行失败
            if (error) {
                outputChannel.appendLine(`❌ [执行失败]: ${error.message}`);
                // 【核心体验】如果报错了，直接把底部控制台弹出来给用户看！
                outputChannel.show(true); 
                reject(error.message || stderr);
            } else {
                outputChannel.appendLine(`✅ [执行成功]`);
                resolve(stdout);
            }
        });
    });
}

// 获取当前保存的博客路径
function getBlogPath(): string | undefined {
    const config = vscode.workspace.getConfiguration('blog-helper');
    const path = config.get<string>('blogPath');
    if (!path) {
        vscode.window.showWarningMessage('请先设置你的博客文件夹路径！(运行命令: Blog: 1. 设置博客文件夹路径)');
        return undefined;
    }
    return path;
}

export function activate(context: vscode.ExtensionContext) {
    // 功能 1：设置博客文件夹路径
    let setPathCmd = vscode.commands.registerCommand('blog-helper.setPath', async () => {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: '选择此文件夹作为博客目录'
        });

        if (uris && uris[0]) {
            const selectedPath = uris[0].fsPath;
            // 将路径保存到 VS Code 的全局配置中
            await vscode.workspace.getConfiguration('blog-helper').update('blogPath', selectedPath, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`博客路径已成功设置为: ${selectedPath}`);
        }
    });

    // 功能 2：初始化全新博客
    let initBlogCmd = vscode.commands.registerCommand('blog-helper.initBlog', async () => {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            openLabel: '选择要在哪里新建博客'
        });

        if (uris && uris[0]) {
            const targetPath = uris[0].fsPath;
            const blogName = await vscode.window.showInputBox({ prompt: '请输入博客文件夹名称 (例如: my_blog)' });
            if (!blogName) return;

            vscode.window.showInformationMessage('正在下载并初始化 Hexo，这可能需要几分钟，请稍候...');
            try {
                await runCommand(`hexo init ${blogName} && cd ${blogName} && npm install`, targetPath);
                
                const fullPath = `${targetPath}/${blogName}`;
                await vscode.workspace.getConfiguration('blog-helper').update('blogPath', fullPath, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`博客初始化成功！路径已自动设置为: ${fullPath}`);
            } catch (err) {
                vscode.window.showErrorMessage(`初始化失败: ${err}`);
            }
        }
    });

    // 功能 3：新建一篇文章
    let newPostCmd = vscode.commands.registerCommand('blog-helper.newPost', async () => {
        const blogPath = getBlogPath();
        if (!blogPath) return;

        const title = await vscode.window.showInputBox({ prompt: '请输入文章标题' });
        if (!title) return; // 用户取消输入则退出

        // ==========================================
        // 【新增逻辑】检查同名文件是否存在
        // ==========================================
        // 拼接出预期的文件物理路径： 博客根目录/source/_posts/标题.md
        const expectedPath = path.join(blogPath, 'source', '_posts', `${title}.md`);
        
        if (fs.existsSync(expectedPath)) {
            // 如果文件存在，弹出带有选项的警告框
            const choice = await vscode.window.showWarningMessage(
                `⚠️ 文章 "${title}.md" 已经存在！\n如果继续，Hexo 会默认新建一个名为 "${title}-1.md" 的文件。`,
                '换个名字 (取消)', '继续创建'
            );
            
            // 如果用户点击了取消，或者直接关掉了弹窗，就终止创建流程
            if (choice !== '继续创建') {
                return;
            }
        }
        // ==========================================

        // 原有的创建与打开逻辑
        try {
            const stdout = await runCommand(`npx hexo new "${title}"`, blogPath);
            vscode.window.showInformationMessage(`文章创建指令执行成功！`);
            
            const match = stdout.match(/Created: (.*\.md)/);
            if (match && match[1]) {
                let filePath = match[1].trim();
                
                if (filePath.startsWith('~')) {
                    filePath = filePath.replace(/^~/, os.homedir());
                }

                const doc = await vscode.workspace.openTextDocument(filePath);
                vscode.window.showTextDocument(doc);
            }
        } catch (err) {
            vscode.window.showErrorMessage(`新建文章失败: ${err}`);
        }
    });

    // 功能 4：一键打包并上传
    let deployCmd = vscode.commands.registerCommand('blog-helper.deploy', async () => {
        const blogPath = getBlogPath();
        if (!blogPath) return;

        // 右下角显示加载动画状态
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "正在清理、打包并上传博客...",
            cancellable: false
        }, async (progress) => {
            try {
                // 智能判断：先 add，然后检测是否有更改，有更改才 commit，最后 push
                const gitCommand = 'git add . && (git diff-index --quiet HEAD || git commit -m "Auto update blog from VS Code") && git push';
                await runCommand(gitCommand, blogPath);vscode.window.showInformationMessage('🎉 博客一键上传成功！');
            } catch (err) {
                vscode.window.showErrorMessage(`上传失败: ${err}`);
            }
        });
    });
    // 功能 5：一键安装/修复依赖
    let installDepsCmd = vscode.commands.registerCommand('blog-helper.installDeps', async () => {
        const blogPath = getBlogPath();
        if (!blogPath) return;

        // 右下角显示加载动画状态
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "正在后台安装/修复依赖，这可能需要 1~2 分钟，请耐心等待...",
            cancellable: false
        }, async (progress) => {
            try {
                // 执行强制安装依赖命令
                await runCommand('npm install --force', blogPath);
                vscode.window.showInformationMessage('🎉 博客依赖安装完成！现在可以正常新建文章和部署了。');
            } catch (err) {
                vscode.window.showErrorMessage(`依赖安装失败: ${err}`);
            }
        });
    });
    // ==========================================
    // 激活并挂载侧边栏
    // ==========================================
    const sidebarProvider = new BlogTreeDataProvider();
    // 这里的 'blogSidebar' 必须和 package.json 里配置的 id 保持完全一致
    vscode.window.registerTreeDataProvider('blogSidebar', sidebarProvider);
    // 将命令注册到插件上下文中
    context.subscriptions.push(setPathCmd, initBlogCmd, newPostCmd, deployCmd, installDepsCmd);
}

export function deactivate() {}

// ==========================================
// 侧边栏核心代码 (TreeView + 折叠菜单支持)
// ==========================================

// 1. 定义侧边栏里的每一行（支持变为“文件夹”）
class BlogTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly commandId: string | undefined, // 文件夹不需要执行命令，允许为 undefined
        public readonly iconName: string,
        public readonly children?: BlogTreeItem[]      // 【新增】子节点数组
    ) {
        // 【核心魔法 1】如果有子节点，它就是“可折叠”的文件夹；如果没有，它就是普通的命令项
        super(label, children === undefined ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
        
        // 只有传入了命令 ID 的，才绑定点击执行事件（文件夹本身不绑定点击事件）
        if (this.commandId) {
            this.command = {
                title: this.label,
                command: this.commandId
            };
        }

        this.iconPath = new vscode.ThemeIcon(iconName);
    }
}

// 2. 组装数据，实现层级结构
class BlogTreeDataProvider implements vscode.TreeDataProvider<BlogTreeItem> {
    getTreeItem(element: BlogTreeItem): vscode.TreeItem {
        return element;
    }

    // 【核心魔法 2】VS Code 会递归调用这个方法来获取菜单层级
    getChildren(element?: BlogTreeItem): Thenable<BlogTreeItem[]> {
        // 如果传了 element，说明用户正在点击展开某个文件夹
        if (element) {
            return Promise.resolve(element.children || []);
        }

        // 根目录：使用更加精简的 UI 文本
        return Promise.resolve([
            // 【高频操作】
            new BlogTreeItem('新建文章', 'blog-helper.newPost', 'edit'),
            new BlogTreeItem('一键发布', 'blog-helper.deploy', 'cloud-upload'),
            
            // 【低频操作】折叠菜单
            new BlogTreeItem('高级设置', undefined, 'settings-gear', [
                new BlogTreeItem('更改路径', 'blog-helper.setPath', 'folder-opened'),
                new BlogTreeItem('修复环境', 'blog-helper.installDeps', 'wrench')
            ])
        ]);
    }
}