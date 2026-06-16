# Contributing to Agent Consult

Thank you for your interest in contributing to **Agent Consult**! We welcome contributions from developers, designers, writers, and anyone looking to improve this multi-agent MCP server.

Here is a guide on how you can contribute to the project.

---

## 🚀 Quick Setup

1. **Fork and Clone the Repository**
   ```bash
   git clone https://github.com/YOUR_USERNAME/agent-consult.git
   cd agent-consult
   ```

2. **Install Dependencies**
   Ensure you have Node.js v20+ and npm installed:
   ```bash
   npm install
   ```

3. **Create local config**
   Copy the example configuration file and fill in your OpenRouter API Key:
   ```bash
   cp config.example.json config.json
   ```

4. **Build the Project**
   Compile the TypeScript files to JavaScript:
   ```bash
   npm run build
   ```

5. **Run in Development Mode**
   Start the server locally with TS-node compilation support (in Node.js v24+):
   ```bash
   npm run dev
   ```

---

## 🛠️ Development Guidelines

* **TypeScript**: Keep all code strictly typed. Avoid using `any` unless absolutely necessary.
* **Code Style**: We follow standard Node.js/TypeScript formatting conventions.
* **Clean Code**: Ensure functions are small, modular, and well-documented.
* **Documentation**: If you are adding a new feature or tool, make sure to update:
  - The main `README.md` and appropriate translations (`README.ru.md`, etc.).
  - The files in `docs/` folder.
  - The specialist profiles in `profiles/` if you add new capabilities or roles.

---

## 📬 Submitting a Pull Request (PR)

1. **Create a Branch**: Create a feature branch off of `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. **Make Changes & Test**: Ensure the project builds successfully by running:
   ```bash
   npm run build
   ```
3. **Commit Changes**: Use clear, conventional commit messages (e.g., `feat: add data engineer role`, `fix: handle openrouter timeout`).
4. **Push & Open PR**: Push to your fork and open a Pull Request against our `main` branch. Provide a clear description of what your PR changes and why.

---

## 💬 Communication & Support

If you have questions, suggestions, or want to discuss a new feature:
* Join our Telegram Channel: [t.me/pomogay_marketing](https://t.me/pomogay_marketing)
* Open an Issue on GitHub: [agent-consult Issues](https://github.com/VKirill/agent-consult/issues)
