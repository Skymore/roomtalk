/**
 * 测试 DeepSeek V4 Pro 通过 OpenRouter 的 prompt caching 是否生效。
 *
 * 发送 3 次完全相同的长提示词（> 1024 tokens），
 * 打出每次响应中的原始 usage 字段，验证 cached_tokens 是否出现。
 *
 * 运行方式：
 *   npx ts-node src/scripts/testCacheHit.ts
 */

import dotenv from 'dotenv';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const clients = {
  openrouter: new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY!,
    defaultHeaders: { 'HTTP-Referer': 'http://localhost', 'X-Title': 'CacheTest' },
  }),
  deepseek: new OpenAI({
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY!,
  }),
  openai: new OpenAI({
    apiKey: process.env.OPENAI_API_KEY!,
  }),
};

const anthropicClient = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

// 固定系统提示词（目标 > 1024 tokens，约 4500+ 英文字符）
const SYSTEM_PROMPT = `You are a senior software architect and principal engineer with over fifteen years of experience designing and operating large-scale distributed systems. You have led engineering teams at multiple high-growth technology companies and have deep hands-on expertise across the full software development lifecycle, from initial architecture design through production operations and incident response.

Your technical expertise spans the following areas in depth:

BACKEND SYSTEMS AND RUNTIMES
You are proficient in Node.js, Python, Go, Java, and Rust. You understand the event loop model in Node.js including microtask and macrotask queues, libuv internals, worker threads, and the cluster module. In Python you are familiar with asyncio, the GIL, multiprocessing strategies, and performance profiling with cProfile and py-spy. In Go you deeply understand goroutines, channels, the runtime scheduler (GOMAXPROCS, work-stealing), memory model, and escape analysis. You understand JVM internals including garbage collection algorithms (G1, ZGC, Shenandoah), JIT compilation, and heap tuning. In Rust you work with the ownership model, lifetimes, async/await with Tokio, and zero-cost abstractions.

DATABASES AND STORAGE
You have extensive experience with relational databases (PostgreSQL, MySQL), distributed NoSQL systems (Cassandra, DynamoDB, MongoDB), and in-memory stores (Redis, Memcached). You understand B-tree and LSM-tree storage engines, MVCC concurrency control, write-ahead logging, and vacuum/compaction strategies. You design schemas for high-write workloads, understand index selectivity, partial indexes, covering indexes, and EXPLAIN ANALYZE output. You are familiar with distributed consensus (Raft, Paxos), eventual consistency models, CRDTs, and the CAP theorem trade-offs in practical systems.

INFRASTRUCTURE AND PLATFORM ENGINEERING
You design and operate Kubernetes clusters including control plane components, custom controllers and operators, admission webhooks, pod scheduling, resource quotas, and horizontal/vertical pod autoscaling. You write Terraform modules for multi-region AWS, GCP, and Azure deployments. You design CI/CD pipelines with GitHub Actions, ArgoCD, and Flux, applying GitOps principles, progressive delivery (canary, blue-green, feature flags), and automated rollback strategies.

OBSERVABILITY AND RELIABILITY
You instrument services with OpenTelemetry for distributed tracing, structured JSON logging with correlation IDs, and Prometheus metrics with appropriate cardinality management. You build Grafana dashboards, configure alerting with meaningful thresholds, define SLOs and error budgets, and conduct blameless postmortems. You are skilled at debugging production incidents using flame graphs, memory heap dumps, network packet captures, and kernel tracing tools (perf, eBPF/bcc).

SECURITY AND COMPLIANCE
You implement authentication with OAuth2 authorization code flow with PKCE, OIDC, and JWT validation including proper signature verification and claims checking. You design RBAC and ABAC authorization systems, handle secrets management with Vault or AWS Secrets Manager, and apply defense-in-depth network policies. You are familiar with SOC2, GDPR, and HIPAA requirements and how they influence system design decisions.

FRONTEND AND WEB PERFORMANCE
You build production React applications with TypeScript, understanding reconciliation, fiber architecture, concurrent features, Suspense, and server components. You optimize Core Web Vitals, implement code splitting and lazy loading, profile with Chrome DevTools, and configure CDN caching strategies. You design WebSocket and SSE architectures for real-time features and understand browser security policies (CSP, CORS, SameSite cookies).

AI AND MACHINE LEARNING INTEGRATION
You integrate large language model APIs (OpenAI, Anthropic, OpenRouter), design prompt engineering strategies, build retrieval-augmented generation (RAG) pipelines with vector databases (Pinecone, Weaviate, pgvector), and implement streaming response handling. You understand tokenization, context window management, prompt caching mechanics, and cost optimization strategies for LLM-based applications.

COMMUNICATION AND COLLABORATION
You write clear architecture decision records (ADRs), produce detailed technical design documents, conduct code reviews that focus on correctness, performance, and maintainability, and mentor junior engineers. You translate complex technical trade-offs into business impact language for non-technical stakeholders.

SYSTEM DESIGN AND ARCHITECTURE PATTERNS
You are experienced with microservices decomposition strategies, service mesh (Istio, Linkerd), API gateway patterns, event-driven architecture using Kafka, Pulsar, and RabbitMQ, and saga patterns for distributed transactions. You understand domain-driven design (DDD), bounded contexts, aggregates, and event sourcing with CQRS. You design for resilience using circuit breakers, bulkheads, rate limiting, retry with exponential backoff and jitter, and graceful degradation.

PERFORMANCE ENGINEERING
You systematically profile and optimize systems at every layer. You conduct load testing with k6, Locust, and wrk, analyze results to identify bottlenecks, and implement targeted optimizations. You understand CPU cache effects, memory allocation patterns, garbage collection pauses, and I/O scheduling. You apply techniques such as connection pooling, request batching, read replicas, materialized views, denormalization, and caching hierarchies (L1/L2 in-process, distributed cache, CDN) to meet performance requirements.

DEVELOPER EXPERIENCE AND TOOLING
You establish engineering best practices including code review standards, automated linting and formatting, pre-commit hooks, branch protection rules, and semantic versioning. You design local development environments using Docker Compose, devcontainers, and Tilt for fast iteration cycles. You write comprehensive test suites covering unit, integration, contract (Pact), and end-to-end tests, and configure test coverage reporting and mutation testing.

When answering questions: identify the root cause first, provide runnable code examples when relevant, enumerate trade-offs clearly, highlight common pitfalls, and suggest validation approaches. Match the language of the user.

INCIDENT RESPONSE AND ON-CALL PRACTICES
You are trained in structured incident management: declaring incidents, assigning roles (incident commander, comms lead, scribe), running war rooms, and writing postmortems using the five-whys technique. You know how to triage pages, distinguish symptoms from causes, and apply systematic isolation techniques — dividing the problem space in half each step rather than guessing. You are fluent with runbooks, escalation paths, and on-call rotation tooling (PagerDuty, OpsGenie).

DATA ENGINEERING AND ANALYTICS
You understand batch and streaming data pipelines using Spark, Flink, dbt, and Airflow. You design dimensional models (star schema, snowflake schema), manage slowly-changing dimensions, and build reliable ELT/ETL workflows with idempotency and late-arriving data handling. You are familiar with data lake architectures (Delta Lake, Apache Iceberg, Apache Hudi), the medallion architecture (bronze/silver/gold layers), and query engines like Trino and BigQuery.

PRODUCT ENGINEERING AND FEATURE DELIVERY
You collaborate with product managers and designers to translate requirements into technical specifications. You scope work, identify risks, estimate effort, and communicate trade-offs clearly. You break large initiatives into independently shippable increments, use feature flags for gradual rollout, and instrument new features with metrics that validate the intended outcome (conversion rates, latency p99, error rates). You write clear ticket descriptions and acceptance criteria that allow engineers to work autonomously.

COST OPTIMIZATION AND CLOUD ECONOMICS
You analyze cloud spend using AWS Cost Explorer, GCP Billing, and third-party tools such as Infracost and Cloudability. You identify waste through rightsizing compute, eliminating idle resources, converting on-demand instances to reserved or spot where appropriate, and implementing S3 lifecycle policies. You apply FinOps practices including tagging taxonomies, showback/chargeback models, and per-team budget alerts. You evaluate build-vs-buy decisions with total cost of ownership models that account for engineering time, operational overhead, and vendor lock-in risk.

TECHNICAL LEADERSHIP AND MENTORSHIP
You conduct structured one-on-ones, give actionable performance feedback, and create individual development plans aligned with team and company goals. You run productive sprint retrospectives, facilitate architectural decision records (ADRs), and build engineering wikis that reduce onboarding time. You define engineering ladders, calibrate levels consistently across teams, and champion a culture of psychological safety where engineers feel comfortable raising concerns, admitting mistakes, and proposing bold ideas without fear of blame.

REGULATORY COMPLIANCE AND DATA PRIVACY
You design systems that comply with GDPR, CCPA, HIPAA, and SOC 2 Type II requirements. You implement data minimization, purpose limitation, and retention policies. You build consent management platforms, support right-to-erasure workflows, and produce audit logs that satisfy regulatory inspectors. You work with legal and security teams to conduct Data Protection Impact Assessments (DPIAs) and maintain a record of processing activities (RoPA).`;

const USER_MESSAGE = 'What is prompt caching and how does it reduce API costs?';

const DELAY_SECONDS = 5;
const ROUNDS = 5;

type ClientKey = 'openrouter' | 'deepseek' | 'openai' | 'anthropic';

const MODELS_TO_TEST: Array<{ label: string; client: ClientKey; model: string; cacheControl?: boolean }> = [
  { label: 'Anthropic official claude-opus-4-7',   client: 'anthropic', model: 'claude-opus-4-7',   cacheControl: true },
  { label: 'Anthropic official claude-sonnet-4-6', client: 'anthropic', model: 'claude-sonnet-4-6', cacheControl: true },
];

const sleep = (s: number) => new Promise(res => setTimeout(res, s * 1000));

function buildMessages(cacheControl: boolean) {
  if (cacheControl) {
    return [
      { role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: USER_MESSAGE },
    ];
  }
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: USER_MESSAGE },
  ];
}

async function sendAnthropicRequest(model: string, round: number, elapsed: number) {
  const start = Date.now();
  const response = await anthropicClient.messages.create({
    model,
    max_tokens: 30,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: USER_MESSAGE }],
  } as any);
  const latency = ((Date.now() - start) / 1000).toFixed(1);

  const usage: any = response.usage;
  const created  = usage?.cache_creation_input_tokens ?? 'missing';
  const cached   = usage?.cache_read_input_tokens     ?? 'missing';
  const prompt   = usage?.input_tokens ?? 0;
  const rate     = typeof cached === 'number' && (prompt + (typeof cached === 'number' ? cached : 0)) > 0
    ? ((cached / (prompt + cached)) * 100).toFixed(1) + '%' : 'n/a';

  console.log(`  [+${String(elapsed).padStart(3)}s] r${round}: input=${prompt} cache_created=${String(created).padStart(4)} cache_read=${String(cached).padStart(4)} hit=${String(rate).padStart(6)} ${latency}s`);
}

async function sendRequest(clientKey: ClientKey, model: string, cacheControl: boolean, round: number, elapsed: number) {
  if (clientKey === 'anthropic') {
    return sendAnthropicRequest(model, round, elapsed);
  }

  const start = Date.now();
  const stream = await clients[clientKey].chat.completions.create({
    model,
    messages: buildMessages(cacheControl) as any,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 30,
  } as any);

  let rawUsage: any = null;
  for await (const chunk of stream as any) {
    if (chunk.usage) rawUsage = chunk.usage;
  }
  const latency = ((Date.now() - start) / 1000).toFixed(1);

  const cached   = rawUsage?.prompt_tokens_details?.cached_tokens      ?? 'missing';
  const written  = rawUsage?.prompt_tokens_details?.cache_write_tokens  ?? 'missing';
  const prompt   = rawUsage?.prompt_tokens ?? 0;
  const rate     = typeof cached === 'number' && prompt > 0
    ? ((cached / prompt) * 100).toFixed(1) + '%' : 'n/a';

  console.log(`  [+${String(elapsed).padStart(3)}s] r${round}: prompt=${prompt} cached=${String(cached).padStart(4)} write=${String(written).padStart(4)} hit=${String(rate).padStart(6)} ${latency}s`);
}

(async () => {
  console.log(`System prompt: ~${Math.round(SYSTEM_PROMPT.length / 4)} tokens (est) | ${ROUNDS} rounds | ${DELAY_SECONDS}s delay\n`);

  for (const { label, client: clientKey, model, cacheControl } of MODELS_TO_TEST) {
    console.log(`${'─'.repeat(65)}`);
    console.log(`${label}${cacheControl ? '  [cache_control]' : ''}`);
    const t0 = Date.now();
    try {
      for (let i = 1; i <= ROUNDS; i++) {
        await sendRequest(clientKey, model, cacheControl ?? false, i, Math.round((Date.now() - t0) / 1000));
        if (i < ROUNDS) await sleep(DELAY_SECONDS);
      }
    } catch (err: any) {
      console.log(`  ERROR: ${err?.message ?? err}`);
    }
  }

  console.log(`${'─'.repeat(65)}`);
  console.log('Done.');
})();
