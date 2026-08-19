# CS Fundamentals Map

**Where the interviewer can take the conversation** once you've explained your project.

This is not a study guide. It's a map of the doors your own answers open — so you can see the
transition coming, and so you can *choose* which door to open when you want to steer toward
something you know well.

---

## How to use this

Every project detail is a hook. When you say *"I use a queue"*, you have invited producer/consumer,
concurrency, retries and idempotency. When you say *"composite index"*, you have invited B-trees.

Two moves:
1. **Anticipate.** Know which fundamental sits behind each thing you say.
2. **Steer.** Mention the hook you *want* — if you're strong on DBMS, say "composite index" early.

---

# 1. BullMQ / Redis → Operating Systems + Concurrency

```
"I use BullMQ for background processing"
        │
        ├── Queue (the data structure)  → FIFO, enqueue/dequeue O(1), array vs linked list
        ├── Producer/Consumer problem   → the classic OS synchronisation problem
        │       └── bounded buffer, semaphores, mutexes, condition variables
        ├── Process vs thread           → your 3 processes have separate memory
        ├── Concurrency vs parallelism  → Node is concurrent, not parallel, on one thread
        ├── Race conditions             → two workers creating the same event
        │       └── critical section, mutual exclusion, atomicity
        ├── Deadlock                    → the four Coffman conditions; you don't hold locks, so
        │                                  you can't deadlock — a good thing to be able to say
        ├── Retry / backoff             → exponential backoff, and why jitter matters at scale
        └── Idempotency                 → at-least-once vs at-most-once vs exactly-once
```

**Most likely transition:** *"You mentioned two workers could race. How do operating systems
solve mutual exclusion?"*
> Mutexes, semaphores, or atomic compare-and-swap. In my case I don't hold a lock at all — I let
> the database's unique constraint be the serialisation point, and the loser gets a constraint
> violation which I treat as success because the desired end state already exists.

**Steer here if:** you're comfortable with OS. Say *"producer/consumer"* explicitly.

---

# 2. PostgreSQL → DBMS

```
"Postgres with composite indexes and a transaction"
        │
        ├── Indexes ────► B-tree / B+ tree
        │       ├── why B+ tree and not a binary search tree → disk pages, fanout, height
        │       ├── O(log n) lookup, and why range scans are cheap in a B+ tree (linked leaves)
        │       ├── composite index leftmost-prefix rule  ◄── YOUR strongest hook
        │       ├── clustered vs non-clustered
        │       └── hash index — O(1) equality, no ranges. Why Postgres defaults to B-tree.
        │
        ├── Transactions ────► ACID
        │       ├── Atomicity      → your update + audit rows
        │       ├── Consistency    → your constraints
        │       ├── Isolation      → Read Committed (yours), and the four levels
        │       │      └── dirty read · non-repeatable read · phantom read
        │       └── Durability     → WAL / write-ahead logging
        │
        ├── Locking ────► shared vs exclusive, row vs table, 2-phase locking
        │       ├── optimistic (version column) vs pessimistic (SELECT FOR UPDATE)
        │       └── deadlock detection
        │
        ├── Normalization ────► 1NF/2NF/3NF/BCNF, and deliberate denormalisation
        │       └── your `company` as a string, not a `companies` table
        │
        ├── Keys ────► primary, foreign, composite, candidate, surrogate vs natural
        │       └── why `googleSub` and not `email` — natural key mutability
        │
        └── Query execution ────► EXPLAIN, seq scan vs index scan, join algorithms
                (nested loop · hash join · merge join)
```

**Most likely transitions:**

*"Why does index order matter?"*
> A composite index is sorted by the first column, then the second within that. So it serves
> `WHERE userId = ?` and `WHERE userId = ? AND date BETWEEN ...`, but not `WHERE date BETWEEN`
> alone — that's the leftmost-prefix rule. It's why every index in my schema starts with
> `userId`: every query is already tenant-scoped, so an index on `date` alone would be scanned
> across every tenant and then filtered.

*"What isolation level, and what anomaly does it allow?"*
> Read Committed, the Postgres default. It prevents dirty reads but allows non-repeatable reads
> and phantoms. In my case that means two concurrent updates to the same event could interleave —
> last commit wins on the row, though both audit rows are still written.

*"Why a B+ tree and not a hash table?"*
> Hash gives O(1) equality but can't do ranges, and my matcher's queries are date ranges. A B+
> tree keeps leaves sorted and linked, so a range scan is one descent plus a linear walk. And on
> disk, fanout matters more than asymptotics — a B+ tree of a few levels covers millions of rows
> in a handful of page reads.

**Steer here if:** DBMS is your strongest coursework. Say *"composite index"* and *"transaction"*
early and they'll follow.

---

# 3. The matching engine → DSA

```
"Three-tier recognition with an identity gate"
        │
        ├── eventKey lookup ────► Hash map
        │       ├── O(1) average, O(n) worst (all collisions)
        │       ├── collision resolution: chaining vs open addressing
        │       ├── load factor and rehashing
        │       └── **your DB unique index is a B-tree, not a hash — know the difference**
        │
        ├── Candidate ranking ────► selection, not sorting
        │       ├── you take the max in one O(n) pass, not sort O(n log n)
        │       ├── with a top-k requirement → a min-heap of size k, O(n log k)
        │       └── stability: you use `>` not `>=`, so ties keep the first
        │
        ├── Date-window queries ────► range search
        │       ├── B+ tree range scan in the database
        │       └── in memory: sorted array + binary search, or an interval tree
        │
        ├── Deduplication ────► set membership
        │       └── you use a JS Set for message ids; at scale, a Bloom filter
        │
        ├── String matching ────► regex = finite automata
        │       ├── NFA vs DFA, and catastrophic backtracking (ReDoS)
        │       └── **your `[\s\S]{0,300}?` is lazy AND bounded — deliberately, so it can't
        │           run away.** That's a genuinely good thing to point at.
        │
        └── Complexity of the pipeline
                per email: 1 indexed lookup + 2 bounded range queries + O(k) scoring
                where k is small because the windows bound it
```

**Most likely transitions:**

*"What's the time complexity of your matching?"*
> Per email: one indexed lookup, then at most two bounded range queries, then a linear pass over
> the candidates. The candidate set is small because the windows bound it — that's a large part
> of why the bounds exist, not just correctness. So it's effectively O(log n) for the index
> descent plus O(k) for scoring, with k small.

*"How would you find the top 3 candidates instead of the best one?"*
> A min-heap of size 3 — push, and pop when it exceeds 3. O(n log 3), which is O(n). Sorting the
> whole list would be O(n log n) for information I'd throw away.

*"Could your regex blow up?"*
> That's why the quote-boundary pattern is both lazy and length-bounded — `[\s\S]{0,300}?`. An
> unbounded `.*` with alternation is how you get catastrophic backtracking.

---

# 4. OAuth / HTTP → Computer Networks

```
"Google OAuth 2.0"
        │
        ├── HTTP ────► request/response, methods, status codes, headers
        │       ├── stateless protocol → why cookies exist at all
        │       ├── 3xx redirects → the whole OAuth flow is redirects
        │       └── idempotent verbs → why POST for state changes
        │
        ├── HTTPS / TLS ────► handshake, certificates, symmetric vs asymmetric
        │       ├── why the code exchange is server-to-server (the secret never ships)
        │       └── TLS termination at a proxy → your `trust proxy` setting
        │
        ├── Cookies ────► attributes, Domain vs Origin, the Public Suffix List
        │       └── **your production bug: vercel.app and onrender.com are separate SITES**
        │
        ├── Same-Origin Policy / CORS ────► preflight, credentials, exact origin matching
        │
        ├── DNS ────► resolution, and why "origin" is scheme+host+port
        │
        ├── JWT ────► header.payload.signature, RS256 vs HS256
        │       └── you verify Google's ID token signature against published public keys
        │
        └── WebSockets vs polling ────► your Gmail sync polls; Convex uses a push channel
```

**Most likely transitions:**

*"Explain the OAuth flow at the HTTP level."*
> A 302 redirect to Google with query parameters. The user consents. Google 302s back to my
> registered redirect URI with a `code` in the query string. My server then makes a POST — a
> normal server-to-server HTTPS request — exchanging that code plus my client secret for tokens.
> The secret and the tokens never appear in the browser.

*"Why did your cookie not work across two domains?"*
> Because cookies are scoped by site, not origin, and both `vercel.app` and `onrender.com` are
> Public Suffix List entries — so those are two different *sites*. A `SameSite=Lax` cookie is
> withheld from cross-site subresource requests. The fix was routing both the API and the OAuth
> callback through one origin with a rewrite.

*"What's the difference between authentication and authorization?"*
> Authentication is who you are, authorization is what you may do. In my system they're
> deliberately separate mechanisms: `requireAuth` resolves the caller and nothing else;
> authorization happens at the persistence boundary as a tenant predicate on every query.

---

# 5. Modules and services → OOP

```
"Parser registry, AI provider interface, storage abstraction"
        │
        ├── Interface / abstraction ────► AttachmentParser, AIProvider, StorageService
        │       └── program to an interface, not an implementation
        │
        ├── Polymorphism ────► PdfParser and SpreadsheetParser behind one interface
        │       └── the registry calls `supports()` without knowing the concrete type
        │
        ├── SOLID
        │       ├── S — DocumentProcessingService orchestrates; parsers parse; the repo persists
        │       ├── O — **your parser registry is the textbook example.** New format = new class
        │       │       + one array entry. No existing file changes.
        │       ├── L — any AttachmentParser substitutes for any other
        │       ├── I — the interface is two methods, not a kitchen sink
        │       └── D — DocumentProcessingService depends on the StorageService *interface*,
        │               with the concrete one injected via a constructor default
        │
        ├── Dependency injection ────► constructor defaults, which is how tests inject fakes
        │
        ├── Composition over inheritance ────► you use zero inheritance; everything composes
        │
        └── Design patterns you actually used
                Strategy   → AttachmentParser
                Registry   → ParserRegistry
                Facade     → structuredCompletion() over provider + parser + retry
                Repository → the *.repository.ts layer
                Singleton  → shared instances (storageService, parserRegistry, openAIProvider)
```

**Most likely transitions:**

*"Give me a real example of the Open/Closed Principle."*
> My parser registry. `DocumentProcessingService` contains zero MIME-type conditionals — it asks
> the registry for a parser and delegates. Adding DOCX means one new class implementing
> `supports()` and `parse()`, plus one line in the registry array. No existing file changes. The
> alternative was a growing if-else chain inside the service, which is what it started as.

*"Where would you use inheritance?"*
> I didn't, anywhere. Every extension point is an interface plus composition. Inheritance would
> couple parsers to a base class's lifecycle for no gain — they share no state, only a contract.
> `TextNormalizer` is the shared behaviour and it's a static utility they *call*, not a base
> class they extend.

---

# 6. Async processing → Distributed Systems

```
"Queue + workers + at-least-once"
        │
        ├── Delivery semantics ────► at-most-once / at-least-once / exactly-once
        │       └── **why exactly-once is effectively impossible across two systems**
        │
        ├── Idempotency ────► the practical answer to at-least-once
        │
        ├── Eventual consistency ────► the Email exists before the Event does
        │
        ├── The dual-write problem ────► write to Postgres AND enqueue to Redis
        │       └── your gap: if the enqueue fails, the email is orphaned at `pending`
        │       └── the standard fix: the transactional outbox pattern
        │
        ├── Failure modes ────► timeout · partial failure · crash-recovery
        │
        ├── Backpressure ────► what happens when producers outrun consumers
        │
        └── (know the names, don't claim to have built them)
                CAP theorem · consensus (Raft/Paxos) · sharding · replication
```

**Most likely transitions:**

*"Why can't you have exactly-once?"*
> Because the queue and the database are two systems. To make "do the work" and "acknowledge the
> job" atomic you'd need a distributed transaction across them. Without that there's always a
> window where the work is done and the ack is lost. So the practical answer is at-least-once
> delivery plus idempotent processing, which is what I built.

*"You write to Postgres and then enqueue to Redis. What if the enqueue fails?"* ← **they will
find this**
> Then the email row exists at `pending` and no job exists — it's the dual-write problem and I
> have it. There's no sweeper picking those up, which is a real gap. The clean fix is a
> transactional outbox: write the job into an outbox table in the *same* transaction as the
> email, and have a separate process relay outbox rows to Redis. Then the only failure mode is
> delayed delivery rather than lost work.

**Knowing the outbox pattern by name here is a strong signal.** Learn it tonight if you don't.

---

# 7. Confidence and matching → a little probability / ML framing

```
"Confidence scoring"
        │
        ├── Weighted scoring ────► linear combination, feature weights
        ├── Calibration ────► **yours is NOT calibrated — say so**
        ├── Threshold selection ────► precision/recall trade-off
        │       └── your asymmetry: a false merge costs far more than a duplicate
        ├── Precision vs recall ────► you optimise for precision on merges
        └── Human-in-the-loop ────► the review queue is exactly this
```

**Most likely transition:** *"How do you know 0.6 is the right threshold?"*
> I don't — it's a hand-tuned heuristic, not a calibrated probability. What it buys me is a
> single ordered scalar that makes "don't act" and "don't overwrite something better"
> expressible at all; the alternative was acting on everything equally, which demonstrably
> destroyed data. Framed properly it's a precision/recall trade-off with a very asymmetric cost —
> a false merge is unrecoverable and a duplicate isn't — so I bias hard toward precision. With
> usage data I'd log every decision alongside the human's eventual correction and fit the
> threshold to that.

---

# 8. React / frontend → less likely, but be ready

```
"React dashboard"
        │
        ├── Virtual DOM / reconciliation ────► keys, diffing
        ├── Rendering ────► state changes trigger re-render; derived vs stored state
        ├── Hooks rules ────► top level only, dependency arrays
        ├── CSR vs SSR ────► Vite SPA vs Next.js App Router
        └── Timezone rendering ────► your explicit `timeZone: "UTC"` decision
```

---

# The transition table — memorise this

| When you say... | Be ready for... |
|---|---|
| "queue" | producer/consumer, race conditions, mutual exclusion |
| "worker crashed" | at-least-once, idempotency, crash recovery |
| "composite index" | **B+ trees, leftmost-prefix rule** |
| "transaction" | **ACID, isolation levels, locking** |
| "unique constraint" | how the DB enforces it; race between two inserts |
| "eventKey lookup" | hash maps vs B-trees; O(1) vs O(log n) |
| "regex" | finite automata, catastrophic backtracking |
| "OAuth" | HTTP redirects, TLS, tokens, authn vs authz |
| "cookie" | SameSite, Public Suffix List, CSRF |
| "parser registry" | **Open/Closed, Strategy pattern, polymorphism** |
| "interface" | SOLID, dependency injection |
| "confidence score" | precision/recall, calibration, thresholds |
| "two workers" | concurrency, deadlock, atomicity |
| "write to DB then enqueue" | **dual-write problem, transactional outbox** |

---

# The three doors to open on purpose

If you get to choose the direction, steer to one of these — each has a strong, specific answer
already written above.

1. **"Composite index leftmost-prefix"** → B+ trees → DBMS depth. Your indexes genuinely
   demonstrate it.
2. **"Open/Closed Principle"** → the parser registry. A textbook example you actually built.
3. **"At-least-once and idempotency"** → distributed-systems reasoning with an honest boundary,
   plus the outbox pattern as the fix you'd make.

---

# The five fundamentals to revise tonight if rusty

1. **Composite index leftmost-prefix rule** — the highest-value single fact here.
2. **The four isolation levels and their anomalies** — you'll be asked, because you said
   "transaction".
3. **At-least-once vs exactly-once**, and *why* exactly-once is impractical across two systems.
4. **The transactional outbox pattern** — the named fix for the one architectural gap they're
   most likely to find.
5. **Virtual destructor / rule of three** — the two C++ questions that follow "you list C++
   first".
