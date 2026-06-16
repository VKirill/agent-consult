# Specialist Profiles and MCP Tool Mapping

In the **Agent Consult** system, each virtual agent runs with a specific profile (role). Depending on the selected role, only the necessary MCP servers are dynamically registered for that agent.

---

## 1. Available Roles and Specializations

1. **`programmer`** (Software Developer)
   * *Focus*: Clean code (SOLID/DRY), automated tests (Unit/E2E), refactoring, bug fixing.
   * *Available MCPs*: `gitnexus`, `repowise`, `context7`.
2. **`web_architect`** (Web Architect / UX & SEO)
   * *Focus*: Page structure, responsiveness, UX/UI, Core Web Vitals, accessibility (WCAG 2.1 AA), technical SEO (Schema.org).
   * *Available MCPs*: `gitnexus`, `repowise`, `vue-docs`, `shadcn`, `nuxt-ui`, `context7`.
3. **`system_architect`** (Infrastructure & DevOps System Architect)
   * *Focus*: Networks, servers, CI/CD, load balancing, Docker, Kubernetes, monitoring (Grafana, Prometheus).
   * *Available MCPs*: `gitnexus`, `repowise`, `postgres`.
4. **`app_architect`** (Distributed Applications Architect)
   * *Focus*: Microservices, DDD, database design (replication, sharding according to Kleppmann), integrations (RabbitMQ/Kafka).
   * *Available MCPs*: `gitnexus`, `repowise`, `postgres`, `context7`.
5. **`marketer`** (Marketing Strategist)
   * *Focus*: Positioning (Ries/Trout), USP, AARRR funnel, SWOT analysis, target audience segmentation (JTBD).
   * *Available MCPs*: `perplexity` (for real-time search of current market information in the external web).
6. **`security_auditor`** (Security Auditor / Security Officer)
   * *Focus*: Vulnerability scanning (OWASP Top 10), injections, secret & API key leaks, dependencies, access control list, secure code architecture.
   * *Available MCPs*: `gitnexus`, `repowise`, `perplexity`, `sentinel`, `skylos`.
   * *Special feature*: Runs by default in **single mode** on the local Codex CLI (model `openai/gpt-5.5`) with the maximum reasoning level (`reasoning_effort = "high"`) without synthesis.
7. **`qa_engineer`** (Quality Assurance Engineer)
   * *Focus*: Test cases (boundary conditions, edge cases), test planning, automated test frameworks (Vitest, Playwright), TDD methodology.
   * *Available MCPs*: `gitnexus`, `repowise`.
8. **`data_engineer`** (Data Engineer)
   * *Focus*: Database schema design (OLAP/OLTP), ETL pipelines, SQL query optimization (EXPLAIN ANALYZE), partitioning.
   * *Available MCPs*: `gitnexus`, `repowise`, `postgres`.
9. **`general`** (Universal Consultant)
   * *Focus*: Initial analysis, task decomposition, routing to specialists, comparing alternatives.
   * *Available MCPs*: `gitnexus`, `repowise`, `context7`.

---

## 2. MCP Server Limitation Logic

Each role has a strictly limited list of MCP servers defined in the `.claude.json` configuration file in the agent's isolated home directory.
* **Security**: Agents cannot access tools that fall outside their area of expertise.
* **Token Savings**: Models do not waste context tokens parsing the schemas of irrelevant tools.
* **Sandbox Boundaries**: Every registered MCP server is launched with read-only permissions (`read_file`) restricted to the current working directory (`WORKSPACE_ROOT`). Writing to project files by sub-agents is blocked (Read-Only mode).
