#!/usr/bin/env node

/**
 * CodeCraft MCP Server - V2.1
 *
 * Enhanced version with a professional git workflow and essential file system operations.
 * * Key improvements:
 * - Streamlined toolset by removing redundant/unnecessary tools.
 * - Added `delete_file` and `move_or_rename_file` for complete file lifecycle management.
 * - Massively enhanced `git_tool` with pull, push, and checkout capabilities, plus a detailed description
 * of a professional development workflow to guide the agent.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import simpleGit from 'simple-git';
import { diff_match_patch } from 'diff-match-patch';
import TreeSitter from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import { Octokit } from '@octokit/rest';

// --- SECURITY: Read the sandbox directory reliably ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJsonPath = path.join(__dirname, 'package.json');
const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
const SANDBOX_DIR = path.resolve(packageJson.projectDirectory);
// Declare the fallback GitHub token. It will use the .env variable first.
const GITHUB_TOKEN_FALLBACK = process.env.GITHUB_TOKEN || "";

class CodeCraftMCPServer {
    constructor() {
        this.server = new Server(
            { name: 'codecraft-mcp', version: '1.0.0' },
            { capabilities: { tools: {} } }
        );
        this.git = simpleGit({ baseDir: SANDBOX_DIR });
        this.dmp = new diff_match_patch();
        this.parser = new TreeSitter();
        this.parser.setLanguage(JavaScript);
        this.setupHandlers();
    }

    _resolveSandboxPath(userPath) {
        const resolvedPath = path.resolve(SANDBOX_DIR, userPath);
        if (!resolvedPath.startsWith(SANDBOX_DIR)) {
            throw new Error(`Security Violation: Path traversal attempt blocked for path: ${userPath}`);
        }
        return resolvedPath;
    }

    setupHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'create_or_overwrite_file',
                    description: `
                        **Purpose:** Creates a new file from scratch or completely replaces an existing file with new content.
                        **When to use:** - Creating new files.
                        - Making extensive changes to small files (< 100 lines).
                        - When other editing tools fail repeatedly.
                        **When NOT to use:** - For small edits in large files (use smart_replace instead).
                        **Example:** To create a simple Python web server file.
                        {
                            "file_path": "server.py",
                            "content": "import http.server\\nimport socketserver\\n\\nPORT = 8000\\nHandler = http.server.SimpleHTTPRequestHandler\\n\\nwith socketserver.TCPServer((\\"\\", PORT), Handler) as httpd:\\n    print(\\"serving at port\\", PORT)\\n    httpd.serve_forever()"
                        }
                    `,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string', description: 'The relative path for the file to be created or overwritten.' },
                            content: { type: 'string', description: 'The full content to write to the file.' }
                        },
                        required: ['file_path', 'content']
                    }
                },
                {
                    name: 'smart_replace',
                    description: `
                        **Purpose:** The MOST RELIABLE way to edit code. Intelligently replaces code by understanding context.
                        **When to use:** ALWAYS try this first for any code changes!
                        **Why it's better:** Handles whitespace, finds similar matches, and works with partial content.
                        
                        **Strategy 1 - Minimal Context (RECOMMENDED):**
                        Include just enough context to uniquely identify the location:
                        {
                            "file_path": "main.py",
                            "old_code": "x = 10",
                            "new_code": "x = 20"
                        }
                        
                        **Strategy 2 - Function/Block Level:**
                        {
                            "file_path": "utils.py",
                            "old_code": "def calculate(x):\\n    return x * 2",
                            "new_code": "def calculate(x):\\n    return x * 3"
                        }
                        
                        **THIS TOOL IS SMART:** - Ignores minor whitespace differences.
                        - Handles indentation intelligently.
                        - Can match partial lines if unique.
                        - Works with any programming language.
                        
                        **Success Rate: 99%** when used correctly!
                    `,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string', description: 'The relative path to the file.' },
                            old_code: { type: 'string', description: 'Code to find (can be partial, will be matched intelligently).' },
                            new_code: { type: 'string', description: 'Code to replace with.' },
                            match_mode: {
                                type: 'string',
                                enum: ['exact', 'fuzzy', 'smart'],
                                default: 'smart',
                                description: 'exact: requires perfect match, fuzzy: allows whitespace differences, smart: intelligent matching (recommended)'
                            }
                        },
                        required: ['file_path', 'old_code', 'new_code']
                    }
                },
                {
                    name: 'search_in_file',
                    description: `
                        **Purpose:** Search for text/patterns in a file and get all occurrences with line numbers.
                        **When to use:** - Before making edits, to find exact locations.
                        - To verify if a change needs to be made.
                        - To find all instances of a variable/function.
                        **Returns:** Array of matches with line numbers and content.
                        **Example:** Find all occurrences of a function name.
                        {
                            "file_path": "main.js",
                            "search_text": "handleClick",
                            "case_sensitive": false
                        }
                    `,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string', description: 'The relative path to the file.' },
                            search_text: { type: 'string', description: 'Text or pattern to search for.' },
                            case_sensitive: { type: 'boolean', default: true, description: 'Whether search should be case sensitive.' }
                        },
                        required: ['file_path', 'search_text']
                    }
                },
                {
                    name: 'get_code_context',
                    description: `
                        **Purpose:** Retrieves a specific snippet of code from a file, including exact line numbers.
                        **When to use:** - Before using smart_replace to see the exact content.
                        - To understand code structure around a specific line.
                        - To verify changes were applied correctly.
                        **Returns:** Lines with numbers in format "LINE_NUM: CONTENT"
                        **Example:** To get the context around a function you want to modify on line 50.
                        {
                            "file_path": "main.js",
                            "line_number": 50,
                            "context_lines": 5
                        }
                        **Note:** Line numbers are 1-based (first line is line 1, not 0).
                    `,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string', description: 'The relative path to the file.' },
                            line_number: { type: 'integer', description: 'The central line number to get context around (1-based).' },
                            context_lines: { type: 'integer', default: 5, description: 'The number of lines to fetch before and after the central line.' }
                        },
                        required: ['file_path', 'line_number']
                    }
                },
                {
                    name: 'delete_lines',
                    description: `
                        **Purpose:** Delete a range of lines from a file.
                        **When to use:** - Removing deprecated functions.
                        - Deleting unused imports.
                        - Cleaning up commented code.
                        **Example:** Delete lines 10-15 (inclusive).
                        {
                            "file_path": "old_code.js",
                            "start_line": 10,
                            "end_line": 15
                        }
                        **Note:** Line numbers are inclusive and 1-based.
                    `,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string', description: 'The relative path to the file.' },
                            start_line: { type: 'integer', description: 'First line to delete (1-based, inclusive).' },
                            end_line: { type: 'integer', description: 'Last line to delete (1-based, inclusive).' }
                        },
                        required: ['file_path', 'start_line', 'end_line']
                    }
                },
                {
                    name: 'execute_shell_command',
                    description: `
                        **Purpose:** Executes any shell command inside the project directory.
                        **When to use:** - Running tests after changes.
                        - Installing dependencies.
                        - Building the project.
                        - Running linters or formatters.
                        **Example 1:** Install dependencies.
                        {
                            "command": "npm install express"
                        }
                        **Example 2:** Run tests.
                        {
                            "command": "python -m pytest tests/",
                            "timeout_seconds": 300
                        }
                        **Note:** Commands run in the project directory with a default 120-second timeout.
                    `,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            command: { type: 'string', description: 'The command to execute.' },
                            timeout_seconds: { type: 'integer', default: 120, description: 'Maximum execution time in seconds.' }
                        },
                        required: ['command']
                    }
                },
                {
                    name: 'read_file_content',
                    description: `
                        **Purpose:** Reads the entire content of a specified file.
                        **When to use:** - Initial understanding of file structure.
                        - Reading configuration files.
                        - Checking file content after modifications.
                        **When NOT to use:** - For large files (use get_code_context instead).
                        **Example:** To read a project's README file.
                        {
                            "file_path": "README.md"
                        }
                    `,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string', description: 'The relative path to the file.' }
                        },
                        required: ['file_path']
                    }
                },
                {
                    name: 'list_directory',
                    description: `
                        **Purpose:** Lists the files and subdirectories within a directory.
                        **When to use:** - Initial project exploration.
                        - Finding files to modify.
                        - Understanding project structure.
                        **Example:** To see what's in the src directory.
                        {
                            "dir_path": "src"
                        }
                        **Note:** Use "." for current directory.
                    `,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            dir_path: { type: 'string', default: '.', description: 'The relative path to the directory.' }
                        },
                        required: []
                    }
                },
                {
                    name: 'delete_file',
                    description: `
                        **Purpose:** Deletes a file from the file system.
                        **When to use:**
                        - Removing temporary files.
                        - Deleting old or unused code files after a refactor.
                        - Cleaning up the project directory.
                        **Example:** To delete a temporary data file.
                        {
                            "file_path": "temp/data.tmp"
                        }
                    `,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string', description: 'The relative path of the file to delete.' }
                        },
                        required: ['file_path']
                    }
                },
                {
                    name: 'move_or_rename_file',
                    description: `
                        **Purpose:** Moves a file or directory to a new location, or renames it.
                        **When to use:**
                        - Renaming a file to better reflect its purpose (e.g., 'utils.js' -> 'api_helpers.js').
                        - Moving a file to a more appropriate directory during a code refactor.
                        **Example 1 (Rename):**
                        {
                            "source_path": "src/old_name.js",
                            "destination_path": "src/new_name.js"
                        }
                        **Example 2 (Move):**
                        {
                            "source_path": "src/component.js",
                            "destination_path": "src/components/component.js"
                        }
                    `,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            source_path: { type: 'string', description: 'The original path of the file or directory.' },
                            destination_path: { type: 'string', description: 'The new path for the file or directory.' }
                        },
                        required: ['source_path', 'destination_path']
                    }
                },
                {
                    name: 'git_tool',
                    description: `
                        **Purpose:** Manages the project's version control with Git, enabling a professional, safe, and collaborative workflow.
                        
                        **THE PROFESSIONAL WORKFLOW (Follow these steps for every task):**
                        
                        **1. Synchronize:** Before starting any work, get the latest code from the remote repository.
                           - **Command:** \`pull\`
                           - **Why:** Prevents conflicts and ensures you are working on the most up-to-date version of the project.
                           
                        **2. Isolate Your Work:** Create a new branch for the feature or bugfix you are working on. NEVER commit directly to 'main' or 'master'.
                           - **Command:** \`checkout\` with \`args: ["-b", "your-branch-name"]\`
                           - **Why:** Isolates your changes, preventing unstable code from affecting the main codebase. Allows for code reviews and parallel development.
                           
                        **3. Develop & Test:** Make your code changes using the file editing tools, and then test them thoroughly using \`execute_shell_command\`.
                        
                        **4. Check Your Changes:** See which files you have modified.
                           - **Command:** \`status\`
                           - **Why:** Gives you a clear overview of your work before you commit it.
                           
                        **5. Stage & Commit:** Add your changes to the staging area and then commit them with a clear, descriptive message.
                           - **Step 5a (Stage):** \`add\` with \`args: ["."]\` to add all changes, or \`args: ["path/to/file.js"]\` for specific files.
                           - **Step 5b (Commit):** \`commit\` with \`args: ["feat: Implement user login functionality"]\`
                           - **Why:** Staging allows you to group related changes into a single commit. A good commit message is crucial for project history.
                           
                        **6. Share Your Work:** Push your new branch and its commits to the remote repository.
                           - **Command:** \`push\` with \`args: ["-u", "origin", "your-branch-name"]\`
                           - **Why:** This makes your work available to others for review or integration and backs it up remotely.
                        
                        **Example Sequence for a New Feature:**
                        1. \`{ "command": "pull" }\`
                        2. \`{ "command": "checkout", "args": ["-b", "feature/add-login-button"] }\`
                        3. ... (use file tools to edit code) ...
                        4. \`{ "command": "execute_shell_command", "command": "npm test" }\`
                        5. \`{ "command": "status" }\`
                        6. \`{ "command": "add", "args": ["src/components/Login.js"] }\`
                        7. \`{ "command": "commit", "args": ["feat: Add new login button component"] }\`
                        8. \`{ "command": "push", "args": ["-u", "origin", "feature/add-login-button"] }\`
                    `,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            command: { type: 'string', enum: ['status', 'diff', 'add', 'commit', 'branch', 'pull', 'push', 'checkout', 'log', 'reset'], description: 'The Git command to execute.' },
                            args: { type: 'array', items: { type: 'string' }, default: [], description: 'Arguments for the command (e.g., branch name, file paths, commit message).' }
                        },
                        required: ['command']
                    }
                },
                {
                    name: 'create_github_repo',
                    description: `
    **Purpose:** Creates a new repository in a user's GitHub account.
    
    **When to use:**
    - To programmatically create a new code repository.
    - To initialize a project on GitHub from the command line.
    
    **Impact:** Automates the creation of GitHub repositories.
    
    **Example:** Create a new private repository named 'my-new-project'.
    {
      "repo_name": "my-new-project",
      "description": "This is a new project.",
      "is_private": true
    }
  `,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            auth_token: {
                                type: 'string',
                                description: 'Optional GitHub Personal Access Token with repo scope. If not provided, the server will use the GITHUB_TOKEN from its environment variables.'
                            },
                            repo_name: {
                                type: 'string',
                                description: 'The name of the new repository'
                            },
                            description: {
                                type: 'string',
                                description: 'A short description of the repository'
                            },
                            is_private: {
                                type: 'boolean',
                                default: false,
                                description: 'Whether the repository should be private'
                            }
                        },
                        required: ['repo_name']
                    }
                }
            ]
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            console.error(`Tool called: ${name}`, args);
            try {
                let result;
                switch (name) {
                    case 'create_or_overwrite_file': result = await this.createOrOverwrite_file(args); break;
                    case 'smart_replace': result = await this.smartReplace(args); break;
                    case 'search_in_file': result = await this.searchInFile(args); break;
                    case 'get_code_context': result = await this.getCodeContext(args); break;
                    case 'delete_lines': result = await this.deleteLines(args); break;
                    case 'execute_shell_command': result = await this.executeShellCommand(args); break;
                    case 'read_file_content': result = await this.readFileContent(args); break;
                    case 'list_directory': result = await this.listDirectory(args); break;
                    case 'delete_file': result = await this.deleteFile(args); break;
                    case 'move_or_rename_file': result = await this.moveOrRenameFile(args); break;
                    case 'git_tool': result = await this.gitTool(args); break;
                    case 'create_github_repo': result = await this.createGithubRepo(args); break;
                    default: throw new Error(`Unknown tool: ${name}`);
                }
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (error) {
                console.error(`Error executing tool '${name}':`, error);
                return {
                    content: [{
                        type: 'text', text: JSON.stringify({
                            error: true,
                            tool_name: name,
                            message: error.message,
                            hint: this.getErrorHint(name, error)
                        }, null, 2)
                    }]
                };
            }
        });
    }

    getErrorHint(toolName, error) {
        const hints = {
            'smart_replace': 'Could not find the specified code. Try using search_in_file to find the exact text, or use less context in old_code.',
            'delete_lines': 'Invalid line range. Ensure start_line <= end_line and both are within file bounds.',
            'git_tool': 'Git command failed. Check your arguments. Common issues: trying to push without committing, or checking out a branch that does not exist.',
            'move_or_rename_file': 'Operation failed. Ensure the source path exists and the destination path is valid.',
            'delete_file': 'Could not delete file. Ensure the file path is correct and the file exists.'
        };
        return hints[toolName] || 'Check inputs and try again.';
    }

    // --- Tool Implementations ---

    async smartReplace({ file_path, old_code, new_code, match_mode = 'smart' }) {
        const safePath = this._resolveSandboxPath(file_path);
        const content = await fs.readFile(safePath, 'utf8');

        let newContent;
        let matchFound = false;

        if (match_mode === 'exact') {
            if (content.includes(old_code)) {
                newContent = content.replace(old_code, new_code);
                matchFound = true;
            }
        } else { // 'smart' or 'fuzzy' will use the smart matching logic
            const result = this.smartMatch(content, old_code, new_code);
            if (result) {
                newContent = result;
                matchFound = true;
            }
        }

        if (!matchFound) {
            throw new Error(`Could not find the specified code to replace. The old_code was not found in the file.`);
        }

        await fs.writeFile(safePath, newContent, 'utf-8');

        return {
            success: true,
            file_path,
            message: 'Code replaced successfully using smart matching.',
            match_mode
        };
    }

    smartMatch(content, oldCode, newCode) {
        // Strategy 1: Direct replacement (handles multi-line exact matches)
        if (content.includes(oldCode)) {
            return content.replace(oldCode, newCode);
        }

        // Strategy 2: Trimmed multi-line match (ignores leading/trailing whitespace on the whole block)
        const lines = content.split('\n');
        const oldLines = oldCode.trim().split('\n').map(l => l.trim());
        const newLines = newCode.split('\n');

        for (let i = 0; i <= lines.length - oldLines.length; i++) {
            let match = true;
            for (let j = 0; j < oldLines.length; j++) {
                if (lines[i + j].trim() !== oldLines[j]) {
                    match = false;
                    break;
                }
            }

            if (match) {
                // Found a match, preserve indentation from the first matched line
                const indent = lines[i].match(/^(\s*)/)[1];
                const indentedNewLines = newLines.map(line => indent + line);
                lines.splice(i, oldLines.length, ...indentedNewLines);
                return lines.join('\n');
            }
        }

        return false; // No match found
    }

    async createOrOverwrite_file({ file_path, content }) {
        const safePath = this._resolveSandboxPath(file_path);
        await fs.mkdir(path.dirname(safePath), { recursive: true });
        await fs.writeFile(safePath, content, 'utf-8');
        return { success: true, file_path, message: 'File created/overwritten successfully.' };
    }

    async deleteFile({ file_path }) {
        const safePath = this._resolveSandboxPath(file_path);
        await fs.unlink(safePath);
        return { success: true, file_path, message: 'File deleted successfully.' };
    }

    async moveOrRenameFile({ source_path, destination_path }) {
        const safeSourcePath = this._resolveSandboxPath(source_path);
        const safeDestPath = this._resolveSandboxPath(destination_path);
        await fs.mkdir(path.dirname(safeDestPath), { recursive: true });
        await fs.rename(safeSourcePath, safeDestPath);
        return { success: true, from: source_path, to: destination_path, message: 'File moved/renamed successfully.' };
    }

    async searchInFile({ file_path, search_text, case_sensitive = true }) {
        const safePath = this._resolveSandboxPath(file_path);
        const content = await fs.readFile(safePath, 'utf8');
        const lines = content.split('\n');
        const matches = [];

        const flags = case_sensitive ? 'g' : 'gi';
        const searchRegex = new RegExp(search_text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);

        lines.forEach((line, index) => {
            if (searchRegex.test(line)) {
                matches.push({
                    line_number: index + 1,
                    content: line,
                });
            }
        });

        return {
            success: true,
            file_path,
            search_text,
            matches,
            total_matches: matches.length
        };
    }

    async getCodeContext({ file_path, line_number, context_lines = 5 }) {
        const safePath = this._resolveSandboxPath(file_path);
        const content = await fs.readFile(safePath, 'utf8');
        const lines = content.split('\n');

        if (line_number < 1 || line_number > lines.length) {
            throw new Error(`Line number ${line_number} is out of range (file has ${lines.length} lines)`);
        }

        const startLine = Math.max(1, line_number - context_lines);
        const endLine = Math.min(lines.length, line_number + context_lines);

        const snippet = [];
        for (let i = startLine - 1; i < endLine; i++) {
            snippet.push(`${i + 1}: ${lines[i]}`);
        }

        return {
            success: true,
            file_path,
            center_line: line_number,
            context: snippet.join('\n'),
            total_lines: lines.length
        };
    }

    async deleteLines({ file_path, start_line, end_line }) {
        const safePath = this._resolveSandboxPath(file_path);
        const content = await fs.readFile(safePath, 'utf8');
        const lines = content.split('\n');

        if (start_line < 1 || end_line > lines.length || start_line > end_line) {
            throw new Error(`Invalid line range: ${start_line}-${end_line} (file has ${lines.length} lines)`);
        }

        const deletedCount = end_line - start_line + 1;
        lines.splice(start_line - 1, deletedCount);

        await fs.writeFile(safePath, lines.join('\n'), 'utf-8');

        return {
            success: true,
            file_path,
            lines_deleted: deletedCount,
            message: `Deleted lines ${start_line}-${end_line} (${deletedCount} lines).`
        };
    }

    async executeShellCommand({ command, timeout_seconds = 120 }) {
        return new Promise((resolve) => {
            exec(command, {
                cwd: SANDBOX_DIR,
                timeout: timeout_seconds * 1000,
                maxBuffer: 10 * 1024 * 1024 // 10MB buffer
            }, (error, stdout, stderr) => {
                resolve({
                    success: !error,
                    exit_code: error ? error.code : 0,
                    stdout: stdout || '',
                    stderr: stderr || '',
                    command,
                    timed_out: error && error.killed && error.signal === 'SIGTERM'
                });
            });
        });
    }

    async readFileContent({ file_path }) {
        const safePath = this._resolveSandboxPath(file_path);
        const content = await fs.readFile(safePath, 'utf8');
        const stats = await fs.stat(safePath);
        return {
            success: true,
            file_path,
            content,
            size_bytes: stats.size,
            lines: content.split('\n').length
        };
    }

    async listDirectory({ dir_path = '.' }) {
        const safePath = this._resolveSandboxPath(dir_path);
        const entries = await fs.readdir(safePath, { withFileTypes: true });

        const items = await Promise.all(entries.map(async (entry) => {
            const fullPath = path.join(safePath, entry.name);
            let stats;
            try {
                stats = await fs.stat(fullPath);
            } catch (e) {
                // Handle broken symlinks or permission errors gracefully
                return { name: entry.name, type: 'inaccessible', size: null, modified: null };
            }
            return {
                name: entry.name,
                type: entry.isDirectory() ? 'directory' : 'file',
                size: entry.isFile() ? stats.size : null,
                modified: stats.mtime
            };
        }));

        return {
            success: true,
            path: dir_path,
            entries: items.sort((a, b) => {
                if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
                return a.name.localeCompare(b.name);
            })
        };
    }

    async gitTool({ command, args = [] }) {
        switch (command) {
            case 'status':
                return { ...(await this.git.status()), success: true };
            case 'diff':
                return { success: true, diff: await this.git.diff(args) };
            case 'add':
                await this.git.add(args.length > 0 ? args : '.');
                return { success: true, message: `Added files: ${args.join(', ') || 'all staged'}` };
            case 'commit':
                if (args.length === 0) throw new Error("Commit message is required.");
                return { success: true, ...(await this.git.commit(args[0])) };
            case 'branch':
                return { success: true, ...(await this.git.branch(args)) };
            case 'pull':
                return { success: true, ...(await this.git.pull(args)) };
            case 'push':
                return { success: true, ...(await this.git.push(args)) };
            case 'checkout':
                return { success: true, message: await this.git.checkout(args) };
            case 'log':
                return { success: true, ...(await this.git.log(args)) };
            case 'reset':
                return { success: true, message: await this.git.reset(args) };
            default:
                throw new Error(`Unsupported git command: ${command}`);
        }
    }

    async createGithubRepo(args) {
        const { repo_name, description, is_private = false, auth_token } = args;

        // Use the token from the tool call first, otherwise use the top-level variable
        const token = auth_token || GITHUB_TOKEN_FALLBACK;

        if (!token) {
            throw new Error('GitHub token is missing. Provide it in the tool call or configure it on the server.');
        }

        try {
            // Initialize Octokit with the token
            const octokit = new Octokit({ auth: token });

            // Call the GitHub API to create the repository
            const response = await octokit.repos.createForAuthenticatedUser({
                name: repo_name,
                description: description,
                private: is_private,
            });

            // Return a success message with the new repo's URL
            const repoUrl = response.data.html_url;
            return {
                content: [
                    {
                        type: 'text',
                        text: `✅ Successfully created GitHub repository!

                        Repository Name: ${repo_name}
                        URL: ${repoUrl}
                        Visibility: ${is_private ? 'Private' : 'Public'}`
                    }
                ]
            };
        } catch (error) {
            // Handle potential errors like bad credentials or repo already exists
            throw new Error(`GitHub repository creation failed: ${error.message}`);
        }
    }

    async start() {
        console.error(`🚀 CodeCraft MCP Server v2.1 is online.`);
        console.error(`🔒 Operating in sandboxed directory: ${SANDBOX_DIR}`);
        console.error(`✨ Enhanced with professional Git workflow and file management tools.`);
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
    }
}

// --- Main Execution ---
try {
    if (!SANDBOX_DIR) {
        throw new Error("CRITICAL: 'projectDirectory' is not defined in package.json.");
    }
    await fs.mkdir(SANDBOX_DIR, { recursive: true });
    const server = new CodeCraftMCPServer();
    server.start().catch((error) => {
        console.error(`\n❌ Critical server error:\n${error.message}\n`);
        process.exit(1);
    });
} catch (error) {
    console.error(`\n❌ Failed to initialize server:\n${error.message}\n`);
    process.exit(1);
}

process.on('SIGINT', () => {
    console.error('\nShutting down gracefully...');
    process.exit(0);
});
