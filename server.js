#!/usr/bin/env node

/**
 * CodeCraft MCP Server - V2.0
 * Production-ready MCP server for autonomous software development
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import simpleGit from 'simple-git';
import { Octokit } from '@octokit/rest';
import { glob } from 'glob';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Setup directory paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SANDBOX_DIR = path.resolve(process.env.PROJECT_DIR || process.cwd());
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const SHELL_MODE = process.env.SHELL_MODE || 'restricted';

// Restricted commands whitelist for security
const ALLOWED_COMMANDS = [
    'npm', 'yarn', 'pnpm', 'node', 'python', 'pip', 'java', 'javac', 'mvn', 'gradle',
    'go', 'cargo', 'rustc', 'gcc', 'g++', 'make', 'cmake', 'git', 'docker',
    'ls', 'dir', 'pwd', 'cat', 'type', 'echo', 'test', 'jest', 'mocha', 'pytest',
    'eslint', 'prettier', 'tsc', 'webpack', 'vite', 'rollup', 'parcel'
];

class CodeCraftMCPServer {
    constructor() {
        this.server = new Server(
            { name: 'codecraft-mcp', version: '2.0.0' },
            { capabilities: { tools: {} } }
        );
        this.git = simpleGit({ baseDir: SANDBOX_DIR });
        this.setupHandlers();
    }

    _resolveSandboxPath(userPath) {
        const resolvedPath = path.resolve(SANDBOX_DIR, userPath);
        if (!resolvedPath.startsWith(SANDBOX_DIR)) {
            throw new Error(`Security: Path traversal blocked - ${userPath}`);
        }
        return resolvedPath;
    }

    _validateShellCommand(command) {
        if (SHELL_MODE === 'unsafe') return true;

        const baseCommand = command.trim().split(/\s+/)[0];
        const commandName = path.basename(baseCommand);

        if (!ALLOWED_COMMANDS.includes(commandName)) {
            throw new Error(`Command '${commandName}' not allowed. Set SHELL_MODE=unsafe to enable.`);
        }
        return true;
    }

    setupHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'create_or_overwrite_file',
                    description: `Creates new file or replaces existing file.
**When to use:** Creating new files, rewriting small files (<100 lines)
**Example:** {"file_path": "app.js", "content": "console.log('hello')"}`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string', description: 'Relative file path' },
                            content: { type: 'string', description: 'Full file content' }
                        },
                        required: ['file_path', 'content']
                    }
                },
                {
                    name: 'smart_replace',
                    description: `Intelligently replaces code with fuzzy matching.
**Strategy 1:** Minimal context for unique strings
**Strategy 2:** Include function/class for safer matches
**Auto-handles:** whitespace, indentation differences`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string', description: 'File to edit' },
                            old_code: { type: 'string', description: 'Code to find (can be partial)' },
                            new_code: { type: 'string', description: 'Replacement code' },
                            match_mode: {
                                type: 'string',
                                enum: ['exact', 'fuzzy', 'smart'],
                                default: 'smart',
                                description: 'Match strategy'
                            }
                        },
                        required: ['file_path', 'old_code', 'new_code']
                    }
                },
                {
                    name: 'search_in_file',
                    description: `Search for text/patterns in file with line numbers.
**Returns:** All matches with line numbers and optional context`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string' },
                            search_text: { type: 'string', description: 'Text or regex pattern' },
                            case_sensitive: { type: 'boolean', default: true },
                            use_regex: { type: 'boolean', default: false },
                            context_lines: { type: 'integer', default: 0, description: 'Lines around match' }
                        },
                        required: ['file_path', 'search_text']
                    }
                },
                {
                    name: 'get_code_context',
                    description: `Get code snippet around specific line.
**Returns:** Numbered lines with context`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string' },
                            line_number: { type: 'integer', description: '1-based line number' },
                            context_lines: { type: 'integer', default: 5 }
                        },
                        required: ['file_path', 'line_number']
                    }
                },
                {
                    name: 'delete_lines',
                    description: `Delete line range from file.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string' },
                            start_line: { type: 'integer', description: 'First line (1-based)' },
                            end_line: { type: 'integer', description: 'Last line (inclusive)' }
                        },
                        required: ['file_path', 'start_line', 'end_line']
                    }
                },
                {
                    name: 'insert_lines',
                    description: `Insert content at specific position.
**Position strategies:**
- Line number: {"line_number": 10, "insert_mode": "after"}
- Pattern: {"after_pattern": "function setup()"}
- Relative: {"relative_to": {"pattern": "class", "offset": 2}}`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string' },
                            content: { type: 'string' },
                            position: {
                                type: 'object',
                                properties: {
                                    line_number: { type: 'integer' },
                                    insert_mode: { type: 'string', enum: ['before', 'after'], default: 'after' },
                                    after_pattern: { type: 'string' },
                                    before_pattern: { type: 'string' },
                                    relative_to: {
                                        type: 'object',
                                        properties: {
                                            pattern: { type: 'string' },
                                            offset: { type: 'integer' }
                                        }
                                    }
                                }
                            },
                            match_occurrence: { type: 'integer', default: 1 },
                            create_if_missing: { type: 'boolean', default: false },
                            preserve_indentation: { type: 'boolean', default: true }
                        },
                        required: ['file_path', 'content', 'position']
                    }
                },
                {
                    name: 'execute_shell_command',
                    description: `Execute shell commands. 
**Restricted mode:** Only safe commands allowed (npm, python, git, etc)
**Set SHELL_MODE=unsafe in .env for unrestricted access**`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            command: { type: 'string' },
                            working_dir: { type: 'string', default: '.', description: 'Relative to project root' },
                            timeout_seconds: { type: 'integer', default: 120 }
                        },
                        required: ['command']
                    }
                },
                {
                    name: 'read_file_content',
                    description: `Read entire file content.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string' }
                        },
                        required: ['file_path']
                    }
                },
                {
                    name: 'list_directory',
                    description: `List directory with filtering.
**Examples:** {"filter": "*.js"}, {"max_depth": 3}`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            dir_path: { type: 'string', default: '.' },
                            filter: { type: 'string', description: 'Glob pattern' },
                            include_hidden: { type: 'boolean', default: false },
                            max_depth: { type: 'integer', default: 1, minimum: 1, maximum: 5 },
                            max_files: { type: 'integer', default: 100 }
                        }
                    }
                },
                {
                    name: 'delete_file',
                    description: `Delete file permanently.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string' }
                        },
                        required: ['file_path']
                    }
                },
                {
                    name: 'move_or_rename_file',
                    description: `Move or rename file/directory.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            source_path: { type: 'string' },
                            destination_path: { type: 'string' }
                        },
                        required: ['source_path', 'destination_path']
                    }
                },
                {
                    name: 'git_status',
                    description: `Get current Git status.`,
                    inputSchema: { type: 'object', properties: {} }
                },
                {
                    name: 'git_diff',
                    description: `Show Git diff of changes.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            staged: { type: 'boolean', default: false }
                        }
                    }
                },
                {
                    name: 'git_add',
                    description: `Stage files for commit.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            files: { type: 'array', items: { type: 'string' }, default: ['.'] }
                        }
                    }
                },
                {
                    name: 'git_commit',
                    description: `Commit staged changes.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            message: { type: 'string' },
                            all: { type: 'boolean', default: false, description: 'Auto-stage all changes' }
                        },
                        required: ['message']
                    }
                },
                {
                    name: 'git_branch',
                    description: `List or create branches.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            create: { type: 'string', description: 'Create new branch' },
                            delete: { type: 'string', description: 'Delete branch' },
                            list: { type: 'boolean', default: true }
                        }
                    }
                },
                {
                    name: 'git_checkout',
                    description: `Switch branches or restore files.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            branch: { type: 'string' },
                            create: { type: 'boolean', default: false },
                            file: { type: 'string', description: 'Restore specific file' }
                        }
                    }
                },
                {
                    name: 'git_pull',
                    description: `Pull changes from remote.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            remote: { type: 'string', default: 'origin' },
                            branch: { type: 'string' }
                        }
                    }
                },
                {
                    name: 'git_push',
                    description: `Push changes to remote.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            remote: { type: 'string', default: 'origin' },
                            branch: { type: 'string' },
                            set_upstream: { type: 'boolean', default: false }
                        }
                    }
                },
                {
                    name: 'git_merge',
                    description: `Merge branch into current branch.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            branch: { type: 'string' },
                            no_ff: { type: 'boolean', default: false }
                        },
                        required: ['branch']
                    }
                },
                {
                    name: 'git_stash',
                    description: `Stash or restore work in progress.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            action: { type: 'string', enum: ['push', 'pop', 'list'], default: 'push' },
                            message: { type: 'string' }
                        }
                    }
                },
                {
                    name: 'git_log',
                    description: `View commit history.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            max_count: { type: 'integer', default: 10 },
                            oneline: { type: 'boolean', default: false }
                        }
                    }
                },
                {
                    name: 'create_github_repo',
                    description: `Create GitHub repository. Requires GITHUB_TOKEN in .env`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            repo_name: { type: 'string' },
                            description: { type: 'string' },
                            is_private: { type: 'boolean', default: false }
                        },
                        required: ['repo_name']
                    }
                },
                {
                    name: 'append_prepend_content',
                    description: `Add content to file start/end.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string' },
                            content: { type: 'string' },
                            position: { type: 'string', enum: ['prepend', 'append'] },
                            create_if_missing: { type: 'boolean', default: false }
                        },
                        required: ['file_path', 'content', 'position']
                    }
                },
                {
                    name: 'search_across_files',
                    description: `Search multiple files at once.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            search_text: { type: 'string' },
                            file_pattern: { type: 'string', default: '*' },
                            case_sensitive: { type: 'boolean', default: true },
                            use_regex: { type: 'boolean', default: false },
                            max_files: { type: 'integer', default: 100 },
                            max_matches_per_file: { type: 'integer', default: 10 },
                            context_lines: { type: 'integer', default: 0 }
                        },
                        required: ['search_text']
                    }
                },
                {
                    name: 'get_file_info',
                    description: `Get file metadata without reading content.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string' },
                            file_paths: { type: 'array', items: { type: 'string' } },
                            include_line_count: { type: 'boolean', default: false }
                        }
                    }
                },
                {
                    name: 'analyze_project',
                    description: `Get comprehensive project overview in one call.
**Returns:** Project type, dependencies, structure, entry points, tests`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            max_depth: { type: 'integer', default: 3 },
                            include_dependencies: { type: 'boolean', default: true },
                            include_git_info: { type: 'boolean', default: true }
                        }
                    }
                }
            ]
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            try {
                let result;
                switch (name) {
                    // File operations
                    case 'create_or_overwrite_file': result = await this.createOrOverwriteFile(args); break;
                    case 'smart_replace': result = await this.smartReplace(args); break;
                    case 'search_in_file': result = await this.searchInFile(args); break;
                    case 'get_code_context': result = await this.getCodeContext(args); break;
                    case 'delete_lines': result = await this.deleteLines(args); break;
                    case 'insert_lines': result = await this.insertLines(args); break;
                    case 'read_file_content': result = await this.readFileContent(args); break;
                    case 'list_directory': result = await this.listDirectory(args); break;
                    case 'delete_file': result = await this.deleteFile(args); break;
                    case 'move_or_rename_file': result = await this.moveOrRenameFile(args); break;
                    case 'append_prepend_content': result = await this.appendPrependContent(args); break;
                    case 'search_across_files': result = await this.searchAcrossFiles(args); break;
                    case 'get_file_info': result = await this.getFileInfo(args); break;

                    // Git operations
                    case 'git_status': result = await this.gitStatus(args); break;
                    case 'git_diff': result = await this.gitDiff(args); break;
                    case 'git_add': result = await this.gitAdd(args); break;
                    case 'git_commit': result = await this.gitCommit(args); break;
                    case 'git_branch': result = await this.gitBranch(args); break;
                    case 'git_checkout': result = await this.gitCheckout(args); break;
                    case 'git_pull': result = await this.gitPull(args); break;
                    case 'git_push': result = await this.gitPush(args); break;
                    case 'git_merge': result = await this.gitMerge(args); break;
                    case 'git_stash': result = await this.gitStash(args); break;
                    case 'git_log': result = await this.gitLog(args); break;

                    // Special operations
                    case 'execute_shell_command': result = await this.executeShellCommand(args); break;
                    case 'create_github_repo': result = await this.createGithubRepo(args); break;
                    case 'analyze_project': result = await this.analyzeProject(args); break;

                    default: throw new Error(`Unknown tool: ${name}`);
                }
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (error) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            error: true,
                            message: error.message,
                            tool: name
                        }, null, 2)
                    }]
                };
            }
        });
    }

    // File Operations
    async createOrOverwriteFile({ file_path, content }) {
        const safePath = this._resolveSandboxPath(file_path);
        await fs.mkdir(path.dirname(safePath), { recursive: true });
        await fs.writeFile(safePath, content, 'utf-8');
        return { success: true, file_path, bytes_written: Buffer.byteLength(content) };
    }

    async smartReplace({ file_path, old_code, new_code, match_mode = 'smart' }) {
        try {
            const safePath = this._resolveSandboxPath(file_path);
            const content = await fs.readFile(safePath, 'utf8');

            let newContent;
            if (match_mode === 'exact') {
                if (!content.includes(old_code)) {
                    throw new Error('Exact match not found');
                }
                newContent = content.replace(old_code, new_code);
            } else if (match_mode === 'smart' || match_mode === 'fuzzy') {
                // FIXED: Completely rewrite smart matching to avoid Promise issues
                newContent = this._performSmartMatch(content, old_code, new_code);
                if (newContent === null) {
                    throw new Error('No match found with smart matching');
                }
            } else {
                throw new Error(`Invalid match_mode: ${match_mode}`);
            }

            // Ensure we have a valid string
            if (typeof newContent !== 'string') {
                throw new Error(`Internal error: newContent is ${typeof newContent}, expected string`);
            }

            // Write the file with the new content
            await fs.writeFile(safePath, newContent, 'utf-8');
            return { success: true, file_path, match_mode };
        } catch (error) {
            throw new Error(`smart_replace failed: ${error.message}`);
        }
    }

    _performSmartMatch(content, oldCode, newCode) {
        // Direct match first
        if (content.includes(oldCode)) {
            return content.replace(oldCode, newCode);
        }

        // Fuzzy line-by-line match
        const lines = content.split('\n');
        const oldLines = oldCode.trim().split('\n').map(l => l.trim());

        for (let i = 0; i <= lines.length - oldLines.length; i++) {
            let match = true;
            for (let j = 0; j < oldLines.length; j++) {
                if (lines[i + j]?.trim() !== oldLines[j]) {
                    match = false;
                    break;
                }
            }

            if (match) {
                // Preserve indentation from first line
                const indent = lines[i].match(/^(\s*)/)?.[1] || '';
                const newLines = newCode.split('\n').map((line, idx) => {
                    if (idx === 0) return line; // First line keeps its original indentation
                    return line.trim() ? indent + line.trim() : line;
                });

                // Replace matched lines with new lines
                lines.splice(i, oldLines.length, ...newLines);
                return lines.join('\n');
            }
        }

        return null; // No match found
    }

    _smartMatch(content, oldCode, newCode) {
        // Direct match
        if (content.includes(oldCode)) {
            return content.replace(oldCode, newCode);
        }

        // Fuzzy line-by-line match
        const lines = content.split('\n');
        const oldLines = oldCode.trim().split('\n').map(l => l.trim());

        for (let i = 0; i <= lines.length - oldLines.length; i++) {
            let match = true;
            for (let j = 0; j < oldLines.length; j++) {
                if (lines[i + j].trim() !== oldLines[j]) {
                    match = false;
                    break;
                }
            }

            if (match) {
                const indent = lines[i].match(/^(\s*)/)[1];
                const newLines = newCode.split('\n').map(line =>
                    line.trim() ? indent + line : line
                );
                lines.splice(i, oldLines.length, ...newLines);
                return lines.join('\n');
            }
        }

        return null;
    }

    async searchInFile({ file_path, search_text, case_sensitive = true, use_regex = false, context_lines = 0 }) {
        const safePath = this._resolveSandboxPath(file_path);
        const content = await fs.readFile(safePath, 'utf8');
        const lines = content.split('\n');
        const matches = [];

        let searchRegex;
        if (use_regex) {
            searchRegex = new RegExp(search_text, case_sensitive ? 'g' : 'gi');
        } else {
            const escaped = search_text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            searchRegex = new RegExp(escaped, case_sensitive ? 'g' : 'gi');
        }

        lines.forEach((line, index) => {
            searchRegex.lastIndex = 0;

            if (searchRegex.test(line)) {
                const match = {
                    line_number: index + 1,
                    content: line
                };

                // Fixed context_lines implementation
                if (context_lines > 0) {
                    const start = Math.max(0, index - context_lines);
                    const end = Math.min(lines.length - 1, index + context_lines);

                    match.context = [];
                    for (let i = start; i <= end; i++) {
                        match.context.push({
                            line_number: i + 1,
                            content: lines[i],
                            is_match: i === index
                        });
                    }
                }

                matches.push(match);
            }
        });

        return { success: true, file_path, search_text, matches, total_matches: matches.length };
    }
    async getCodeContext({ file_path, line_number, context_lines = 5 }) {
        const safePath = this._resolveSandboxPath(file_path);
        const content = await fs.readFile(safePath, 'utf8');
        const lines = content.split('\n');

        if (line_number < 1 || line_number > lines.length) {
            throw new Error(`Line ${line_number} out of range (file has ${lines.length} lines)`);
        }

        const start = Math.max(1, line_number - context_lines);
        const end = Math.min(lines.length, line_number + context_lines);

        const snippet = [];
        for (let i = start - 1; i < end; i++) {
            snippet.push(`${i + 1}: ${lines[i]}`);
        }

        return { success: true, file_path, center_line: line_number, context: snippet.join('\n') };
    }

    async deleteLines({ file_path, start_line, end_line }) {
        const safePath = this._resolveSandboxPath(file_path);
        const content = await fs.readFile(safePath, 'utf8');
        const lines = content.split('\n');

        if (start_line < 1 || end_line > lines.length || start_line > end_line) {
            throw new Error(`Invalid range ${start_line}-${end_line} (file has ${lines.length} lines)`);
        }

        lines.splice(start_line - 1, end_line - start_line + 1);
        await fs.writeFile(safePath, lines.join('\n'), 'utf-8');

        return {
            success: true,
            file_path,
            lines_deleted: end_line - start_line + 1,
            new_total_lines: lines.length
        };
    }

    async insertLines({ file_path, content, position, match_occurrence = 1, create_if_missing = false, preserve_indentation = true }) {
        const safePath = this._resolveSandboxPath(file_path);

        let fileContent = '';
        try {
            fileContent = await fs.readFile(safePath, 'utf8');
        } catch (error) {
            if (create_if_missing && error.code === 'ENOENT') {
                await fs.mkdir(path.dirname(safePath), { recursive: true });
                fileContent = '';
            } else {
                throw error;
            }
        }

        const lines = fileContent.split('\n');
        let insertIndex = -1;
        let matchedLine = '';

        // Determine insertion position
        if (position.line_number !== undefined) {
            insertIndex = position.insert_mode === 'before' ?
                position.line_number - 1 : position.line_number;
        } else if (position.after_pattern || position.before_pattern) {
            const pattern = position.after_pattern || position.before_pattern;
            const isAfter = !!position.after_pattern;
            let occurrenceCount = 0;

            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(pattern)) {
                    occurrenceCount++;
                    if (occurrenceCount === match_occurrence) {
                        insertIndex = isAfter ? i + 1 : i;
                        matchedLine = lines[i];
                        break;
                    }
                }
            }

            if (insertIndex === -1) {
                throw new Error(`Pattern "${pattern}" not found`);
            }
        } else if (position.relative_to) {
            const { pattern, offset } = position.relative_to;
            let found = false;

            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(pattern)) {
                    insertIndex = i + offset + (offset >= 0 ? 1 : 0);
                    matchedLine = lines[i];
                    found = true;
                    break;
                }
            }

            if (!found) {
                throw new Error(`Pattern "${pattern}" not found`);
            }
        }

        // Apply indentation
        let processedContent = content;
        if (preserve_indentation && matchedLine) {
            const indent = matchedLine.match(/^(\s*)/)[1];
            processedContent = content.split('\n')
                .map((line, i) => i === 0 || !line.trim() ? line : indent + line)
                .join('\n');
        }

        lines.splice(insertIndex, 0, ...processedContent.split('\n'));
        await fs.writeFile(safePath, lines.join('\n'), 'utf-8');

        return {
            success: true,
            file_path,
            inserted_at_line: insertIndex + 1,
            lines_inserted: processedContent.split('\n').length
        };
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

    async listDirectory({ dir_path = '.', filter, include_hidden = false, max_depth = 1, max_files = 100 }) {
        const safePath = this._resolveSandboxPath(dir_path);
        const results = [];

        async function scanDir(currentPath, currentDepth) {
            if (currentDepth > max_depth || results.length >= max_files) return;

            const entries = await fs.readdir(currentPath, { withFileTypes: true });

            for (const entry of entries) {
                if (results.length >= max_files) break;
                if (!include_hidden && entry.name.startsWith('.')) continue;

                const fullPath = path.join(currentPath, entry.name);
                const relativePath = path.relative(safePath, fullPath);

                if (filter) {
                    const pattern = new RegExp(filter.replace(/\*/g, '.*'));
                    if (!pattern.test(entry.name)) continue;
                }

                const stats = await fs.stat(fullPath);
                results.push({
                    name: entry.name,
                    path: relativePath || '.',
                    type: entry.isDirectory() ? 'directory' : 'file',
                    size: stats.size,
                    modified: stats.mtime
                });

                if (entry.isDirectory() && currentDepth < max_depth) {
                    await scanDir(fullPath, currentDepth + 1);
                }
            }
        }

        await scanDir(safePath, 1);
        return { success: true, path: dir_path, entries: results, total: results.length };
    }

    async deleteFile({ file_path }) {
        const safePath = this._resolveSandboxPath(file_path);
        await fs.unlink(safePath);
        return { success: true, file_path };
    }

    async moveOrRenameFile({ source_path, destination_path }) {
        const safeSrc = this._resolveSandboxPath(source_path);
        const safeDst = this._resolveSandboxPath(destination_path);
        await fs.mkdir(path.dirname(safeDst), { recursive: true });
        await fs.rename(safeSrc, safeDst);
        return { success: true, from: source_path, to: destination_path };
    }

    async appendPrependContent({ file_path, content, position, create_if_missing = false }) {
        const safePath = this._resolveSandboxPath(file_path);

        let existing = '';
        try {
            existing = await fs.readFile(safePath, 'utf8');
        } catch (error) {
            if (!create_if_missing || error.code !== 'ENOENT') throw error;
        }

        const newContent = position === 'prepend' ? content + existing : existing + content;
        await fs.writeFile(safePath, newContent, 'utf-8');

        return { success: true, file_path, position, bytes_added: Buffer.byteLength(content) };
    }

    async searchAcrossFiles({ search_text, file_pattern = '*', case_sensitive = true, use_regex = false, max_files = 100, max_matches_per_file = 10, context_lines = 0 }) {
        const files = await glob(file_pattern, {
            cwd: SANDBOX_DIR,
            nodir: true,
            ignore: ['node_modules/**', '.git/**', '**/*.min.js']
        });

        const results = [];
        const filesToSearch = files.slice(0, max_files);

        let searchRegex;
        if (use_regex) {
            searchRegex = new RegExp(search_text, case_sensitive ? 'g' : 'gi');
        } else {
            const escaped = search_text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            searchRegex = new RegExp(escaped, case_sensitive ? 'g' : 'gi');
        }

        for (const file of filesToSearch) {
            const filePath = path.join(SANDBOX_DIR, file);
            try {
                const content = await fs.readFile(filePath, 'utf8');
                const lines = content.split('\n');
                const fileMatches = [];

                for (let i = 0; i < lines.length && fileMatches.length < max_matches_per_file; i++) {
                    if (searchRegex.test(lines[i])) {
                        const match = {
                            line_number: i + 1,
                            content: lines[i]
                        };

                        if (context_lines > 0) {
                            const start = Math.max(0, i - context_lines);
                            const end = Math.min(lines.length - 1, i + context_lines);
                            match.context = lines.slice(start, end + 1).map((l, idx) => ({
                                line_number: start + idx + 1,
                                content: l,
                                is_match: start + idx === i
                            }));
                        }

                        fileMatches.push(match);
                    }
                    searchRegex.lastIndex = 0;
                }

                if (fileMatches.length > 0) {
                    results.push({
                        file_path: file,
                        matches: fileMatches,
                        match_count: fileMatches.length
                    });
                }
            } catch (error) {
                // Skip binary/unreadable files
            }
        }

        return {
            success: true,
            search_text,
            files_searched: filesToSearch.length,
            files_with_matches: results.length,
            results
        };
    }

    async getFileInfo({ file_path, file_paths, include_line_count = false }) {
        const paths = file_paths || [file_path];
        const results = [];

        for (const fp of paths) {
            try {
                const safePath = this._resolveSandboxPath(fp);
                const stats = await fs.stat(safePath);
                const info = {
                    file_path: fp,
                    exists: true,
                    type: stats.isDirectory() ? 'directory' : 'file',
                    size_bytes: stats.size,
                    modified: stats.mtime,
                    created: stats.birthtime
                };

                if (include_line_count && stats.isFile()) {
                    try {
                        const content = await fs.readFile(safePath, 'utf8');
                        info.line_count = content.split('\n').length;
                    } catch {
                        info.line_count = null;
                    }
                }

                results.push(info);
            } catch (error) {
                results.push({
                    file_path: fp,
                    exists: false,
                    error: error.message
                });
            }
        }

        return {
            success: true,
            results: file_paths ? results : results[0]
        };
    }

    // Shell command execution
    async executeShellCommand({ command, working_dir = '.', timeout_seconds = 120 }) {
        this._validateShellCommand(command);
        const cwd = this._resolveSandboxPath(working_dir);

        return new Promise((resolve) => {
            exec(command, {
                cwd,
                timeout: timeout_seconds * 1000,
                maxBuffer: 10 * 1024 * 1024
            }, (error, stdout, stderr) => {
                resolve({
                    success: !error,
                    exit_code: error?.code || 0,
                    stdout: stdout || '',
                    stderr: stderr || '',
                    command,
                    working_dir,
                    timed_out: error?.killed && error?.signal === 'SIGTERM'
                });
            });
        });
    }

    // Git operations
    async gitStatus() {
        const status = await this.git.status();
        return { success: true, ...status };
    }

    async gitDiff({ staged = false }) {
        const diff = staged ?
            await this.git.diff(['--cached']) :
            await this.git.diff();
        return { success: true, diff };
    }

    async gitAdd({ files = ['.'] }) {
        await this.git.add(files);
        return { success: true, staged: files };
    }

    async gitCommit({ message, all = false }) {
        const args = all ? ['-a', '-m', message] : ['-m', message];
        const result = await this.git.commit(message, all ? { '-a': null } : undefined);
        return { success: true, ...result };
    }

    async gitBranch({ create, delete: del, list = true }) {
        if (create) {
            await this.git.checkoutLocalBranch(create);
            return { success: true, created: create };
        }
        if (del) {
            await this.git.deleteLocalBranch(del);
            return { success: true, deleted: del };
        }
        const branches = await this.git.branch();
        return { success: true, ...branches };
    }

    async gitCheckout({ branch, create = false, file }) {
        if (file) {
            await this.git.checkout(['--', file]);
            return { success: true, restored: file };
        }
        if (create) {
            await this.git.checkoutLocalBranch(branch);
        } else {
            await this.git.checkout(branch);
        }
        return { success: true, branch };
    }

    async gitPull({ remote = 'origin', branch }) {
        const args = branch ? [remote, branch] : [remote];
        const result = await this.git.pull(...args);
        return { success: true, ...result };
    }

    async gitPush({ remote = 'origin', branch, set_upstream = false }) {
        const args = [remote];
        if (branch) args.push(branch);
        if (set_upstream) args.unshift('-u');

        const result = await this.git.push(args);
        return { success: true, pushed: true, remote, branch };
    }

    async gitMerge({ branch, no_ff = false }) {
        const options = no_ff ? { '--no-ff': null } : {};
        const result = await this.git.merge([branch], options);
        return { success: true, ...result };
    }

    async gitStash({ action = 'push', message }) {
        switch (action) {
            case 'push':
                const stashArgs = message ? ['push', '-m', message] : ['push'];
                await this.git.stash(stashArgs);
                return { success: true, action: 'pushed' };
            case 'pop':
                await this.git.stash(['pop']);
                return { success: true, action: 'popped' };
            case 'list':
                const list = await this.git.stashList();
                return { success: true, stashes: list.all };
            default:
                throw new Error(`Unknown stash action: ${action}`);
        }
    }

    async gitLog({ max_count = 10, oneline = false }) {
        const options = {
            maxCount: max_count,
            format: oneline ? { oneline: true } : undefined
        };
        const log = await this.git.log(options);
        return { success: true, commits: log.all };
    }

    // GitHub operations
    async createGithubRepo({ repo_name, description, is_private = false }) {
        if (!GITHUB_TOKEN) {
            throw new Error('GITHUB_TOKEN not configured in .env file');
        }

        const octokit = new Octokit({ auth: GITHUB_TOKEN });
        const response = await octokit.repos.createForAuthenticatedUser({
            name: repo_name,
            description,
            private: is_private
        });

        return {
            success: true,
            repo_name,
            url: response.data.html_url,
            ssh_url: response.data.ssh_url,
            clone_url: response.data.clone_url
        };
    }

    // Project analysis
    async analyzeProject({ max_depth = 3, include_dependencies = true, include_git_info = true }) {
        const analysis = {
            project_type: 'unknown',
            root_path: SANDBOX_DIR,
            structure: {},
            entry_points: [],
            test_files: [],
            config_files: [],
            dependencies: null,
            git_info: null
        };

        // Detect project type and dependencies
        const files = await fs.readdir(SANDBOX_DIR);

        if (files.includes('package.json')) {
            analysis.project_type = 'node.js';
            if (include_dependencies) {
                try {
                    const pkg = JSON.parse(await fs.readFile(path.join(SANDBOX_DIR, 'package.json'), 'utf8'));
                    analysis.dependencies = {
                        prod: Object.keys(pkg.dependencies || {}),
                        dev: Object.keys(pkg.devDependencies || {})
                    };
                    analysis.entry_points.push(pkg.main || 'index.js');
                    if (pkg.scripts?.test) analysis.test_command = pkg.scripts.test;
                } catch { }
            }
        } else if (files.includes('requirements.txt') || files.includes('setup.py')) {
            analysis.project_type = 'python';
            if (include_dependencies && files.includes('requirements.txt')) {
                try {
                    const reqs = await fs.readFile(path.join(SANDBOX_DIR, 'requirements.txt'), 'utf8');
                    analysis.dependencies = reqs.split('\n').filter(l => l && !l.startsWith('#'));
                } catch { }
            }
        } else if (files.includes('pom.xml')) {
            analysis.project_type = 'java-maven';
        } else if (files.includes('build.gradle')) {
            analysis.project_type = 'java-gradle';
        } else if (files.includes('Cargo.toml')) {
            analysis.project_type = 'rust';
        } else if (files.includes('go.mod')) {
            analysis.project_type = 'go';
        }

        // Get directory structure
        const getStructure = async (dir, depth) => {
            if (depth > max_depth) return null;

            const entries = await fs.readdir(dir, { withFileTypes: true });
            const structure = {};

            for (const entry of entries) {
                if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    structure[entry.name + '/'] = await getStructure(fullPath, depth + 1);
                } else {
                    structure[entry.name] = 'file';

                    // Identify special files
                    if (entry.name.match(/\.(test|spec)\.(js|ts|py|java)$/)) {
                        analysis.test_files.push(path.relative(SANDBOX_DIR, fullPath));
                    }
                    if (entry.name.match(/^(config|settings|.*rc)\.(json|js|yaml|yml)$/)) {
                        analysis.config_files.push(path.relative(SANDBOX_DIR, fullPath));
                    }
                    if (!analysis.entry_points.length && entry.name.match(/^(index|main|app)\.(js|ts|py|java)$/)) {
                        analysis.entry_points.push(path.relative(SANDBOX_DIR, fullPath));
                    }
                }
            }

            return structure;
        };

        analysis.structure = await getStructure(SANDBOX_DIR, 1);

        // Get git info
        if (include_git_info) {
            try {
                const status = await this.git.status();
                const branch = await this.git.branch();
                analysis.git_info = {
                    current_branch: branch.current,
                    branches: branch.all,
                    modified_files: status.modified.length,
                    untracked_files: status.not_added.length,
                    ahead: status.ahead,
                    behind: status.behind
                };
            } catch {
                analysis.git_info = { initialized: false };
            }
        }

        return analysis;
    }

    async start() {
        console.error(`🚀 CodeCraft MCP Server v2.0`);
        console.error(`📁 Working directory: ${SANDBOX_DIR}`);
        console.error(`🔒 Shell mode: ${SHELL_MODE}`);
        console.error(`🔑 GitHub token: ${GITHUB_TOKEN ? 'configured' : 'not configured'}`);

        const transport = new StdioServerTransport();
        await this.server.connect(transport);
    }
}

// Start server
(async () => {
    try {
        const server = new CodeCraftMCPServer();
        await server.start();
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
})();

process.on('SIGINT', () => {
    console.error('\n👋 Shutting down gracefully...');
    process.exit(0);
});