# CodeCraft MCP Server

A sophisticated Model Context Protocol (MCP) server for Claude Desktop that provides a comprehensive suite of tools for masterful software development, including intelligent code analysis, version control, and automated execution.

## What is CodeCraft MCP?

CodeCraft MCP is an advanced MCP server designed to work seamlessly with Claude Desktop, empowering Claude to autonomously edit and manage code in your projects with professional-grade precision. It provides a complete toolkit for Claude to modify files, analyze code structure, execute shell commands, and perform comprehensive Git operations following industry best practices.

## 🚀 Key Features

- **Intelligent Code Editing**: 99% success rate with smart code replacement and context-aware modifications
- **Professional Git Workflow**: Complete version control with branching, merging, and remote operations
- **Comprehensive File Management**: Create, edit, delete, move, and organize files with security safeguards
- **Advanced Code Analysis**: Search, context retrieval, and structure understanding
- **Shell Command Execution**: Run tests, install dependencies, and execute build processes
- **GitHub Integration**: Create repositories and manage remote Git operations
- **Security-First Design**: Sandboxed execution with path traversal protection

## 📋 Prerequisites

Before setting up CodeCraft MCP, ensure you have:

- **Node.js** ≥ 18.0.0 ([Download from nodejs.org](https://nodejs.org/))
- **Claude Desktop** application ([Download from claude.ai](https://claude.ai/download))
- **Git** installed for version control features
- **Basic familiarity** with command line and text editing

## 🛠️ Installation & Setup

### Step 1: Download and Prepare the Server

1. **Download CodeCraft MCP**
   - Clone or download this repository to your local machine
   - Note the full path where you saved the files (you'll need this later)

2. **Configure Your Project Directory**
   - Open the `package.json` file in the CodeCraft MCP directory
   - Update the `projectDirectory` field to point to your target project:
   ```json
   "projectDirectory": "C:\\\\Users\\\\username\\\\path\\\\to\\\\your\\\\project"
   ```
   - **Important**: Use double backslashes (`\\\\`) for Windows paths
   - **Example paths**:
     - Windows: `"C:\\\\Users\\\\john\\\\Documents\\\\MyProject"`
     - macOS/Linux: `"/Users/john/Documents/MyProject"`

3. **Install Dependencies**
   ```bash
   # Navigate to the CodeCraft MCP directory
   cd path/to/codecraft-mcp
   
   # Install required packages
   npm install
   ```

4. **Set Up Environment Variables (Optional)**
   - Create a `.env` file in the CodeCraft MCP directory
   - Add your GitHub token for repository operations:
   ```bash
   GITHUB_TOKEN=your_personal_access_token_here
   ```

### Step 2: Configure Claude Desktop

1. **Locate Claude Desktop Configuration**
   
   The configuration file is located at:
   - **Windows**: `C:\Users\[username]\AppData\Roaming\Claude\claude_desktop_config.json`
   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
   
   *Replace `[username]` with your actual computer username*

2. **Edit the Configuration File**
   
   Open the `claude_desktop_config.json` file and add CodeCraft MCP to the `mcpServers` section:

   ```json
   {
     "mcpServers": {
       "codecraft-mcp": {
         "command": "node",
         "args": [
           "C:\\\\path\\\\to\\\\codecraft-mcp\\\\server.js"
         ],
         "env": {}
       }
     }
   }
   ```

   **Important Notes**:
   - Replace `C:\\\\path\\\\to\\\\codecraft-mcp\\\\server.js` with the actual path to your server.js file
   - Use double backslashes (`\\\\`) for Windows paths
   - If you have other MCP servers configured, add CodeCraft MCP alongside them

### Step 3: Launch and Verify

1. **Restart Claude Desktop**
   - **Important**: Completely quit Claude Desktop (not just close the window)
   - Restart the application to load the new configuration

2. **Verify Connection**
   - Click on the **connectors panel** (usually on the left side or accessible via settings)
   - Look for **"codecraft-mcp"** in the list of available connectors
   - Ensure the toggle switch next to "codecraft-mcp" is **enabled (blue)**
   - If you see "codecraft-mcp" listed and enabled, the server is successfully connected!
   - You can click on the arrow next to "codecraft-mcp" to view available tools

3. **Test the Connection**
   Try asking Claude:
   ```
   "Can you show me the files in my project directory?"
   ```
   
   Claude should respond by using CodeCraft MCP tools to list your project files.

## 🎯 Using CodeCraft MCP with Claude

Once configured, you can leverage CodeCraft MCP for various development tasks:

### Code Development
- *"Help me refactor this authentication module to use JWT tokens"*
- *"Create a new React component for the user dashboard"*
- *"Fix the bug in the payment processing function"*
- *"Add error handling to all the API calls in this file"*

### Project Management
- *"Set up a new feature branch and implement the user profile page"*
- *"Run the test suite and fix any failing tests"*
- *"Create a pull request with my recent changes"*
- *"Deploy the application and check if everything works"*

### Code Analysis
- *"Analyze the codebase structure and suggest improvements"*
- *"Find all instances where we're not handling errors properly"*
- *"Show me the dependencies between different modules"*

## 🔧 Available Tools

CodeCraft MCP provides Claude with these powerful capabilities:

| Tool Category | Tools | Description |
|---------------|-------|-------------|
| **File Operations** | create, read, delete, move, list | Complete file lifecycle management |
| **Code Editing** | smart_replace, search, context, delete_lines | Intelligent code modifications |
| **Version Control** | git operations, GitHub integration | Professional Git workflow |
| **Execution** | shell commands | Run tests, build, and deploy |
