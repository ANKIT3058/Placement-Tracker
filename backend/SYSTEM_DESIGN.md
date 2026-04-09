# 🚀 Placement Tracking System — Backend Design

## 1. 🧠 Overview

This is a production-grade backend system that processes **placement-related emails** and converts them into **structured, trackable events**.

### 🎯 Goal

Automate extraction, tracking, and updating of placement events while ensuring:

* data accuracy
* robustness to noisy inputs
* safe updates
* explainable decisions

---

## 2. 🏗️ High-Level Architecture

```text
POST /email
   ↓
Email Service
   ↓
Extraction Service
   ↓
Matching Service
   ↓
Event Service
   ↓
PostgreSQL (via Prisma)
```

---

## 3. ⚙️ Tech Stack

* Node.js + Express
* TypeScript
* PostgreSQL (Docker)
* Prisma ORM
* Jest (unit + integration testing)

---

## 4. 🔄 End-to-End Flow

### Step-by-step:

1. Email received via API
2. Text cleaned and normalized
3. Structured data extracted (regex-based)
4. Confidence score computed
5. Matching system finds best candidate event
6. Decision layer:

   * update existing event OR
   * create new event OR
   * create review event
7. Changes logged (audit trail)
8. Response returned

---

## 5. 🧩 Core Modules

### 5.1 Email Module

* receives email input
* cleans and preprocesses text

---

### 5.2 Extraction Module

Extracts:

* company
* stage
* date
* time
* venue

Features:

* deterministic (regex-based)
* handles real-world noisy inputs
* supports relative dates (tomorrow, next week)

---

### 5.3 Matching Module

Responsible for:

* preventing duplicate events
* linking emails to existing events

---

### Evolution:

#### Before:

```text
first match wins ❌
```

#### After:

```text
best match wins (scoring-based) ✅
```

---

### Matching Strategy

1. Exact match (eventKey)
2. Soft match (± date window)
3. Loose match (company + stage)

---

### Scoring System

```ts
score =
  dateScore * 0.5 +
  stageScore * 0.3 +
  confidenceScore * 0.2;
```

---

### Explainable Matching

Each match includes:

```ts
{
  event,
  confidence,
  explanation: "Exact date match + Stage matched + Strong confidence"
}
```

---

## 6. 📊 Confidence Scoring System

### Purpose

Quantify reliability of extracted data.

---

### Factors

| Field   | Logic               |
| ------- | ------------------- |
| date    | exact > relative    |
| time    | exact > estimated   |
| venue   | explicit > inferred |
| stage   | deterministic       |
| company | required            |

---

### Output

```ts
{
  data,
  confidence: number
}
```

---

### Key Idea

> Not all extracted data should be trusted equally.

---

## 7. 🧠 Decision Layer (Core Intelligence)

The system behaves differently based on confidence.

---

### Case 1: High Confidence

```text
→ update existing event OR create new event
```

---

### Case 2: Low Confidence

```text
→ DO NOT update existing event
→ create event with status = "review"
```

---

### Example

```ts
if (confidence < THRESHOLD) {
  createEvent({
    status: "review",
    reviewReason: "Low confidence extraction"
  });
}
```

---

### Key Principle

> Uncertain data should not overwrite reliable data.

---

## 8. 🔄 Event Update System

### Problem Solved

Avoid destructive updates.

---

### Rules

Update only when:

```ts
value exists &&
value changed
```

---

### Confidence Guard

```ts
if (newConfidence < existingConfidence) {
  skip update;
}
```

---

### Result

* prevents data corruption
* ensures data integrity

---

## 9. 🧠 Intent-Aware Venue Handling

### Problem

Could not distinguish:

* missing venue
* invalid venue

---

### Solution

```ts
type VenueMeta = {
  value: string | null;
  isExplicit: boolean;
};
```

---

### Behavior

| Scenario         | Result             |
| ---------------- | ------------------ |
| explicit invalid | clears DB          |
| no mention       | preserves existing |

---

## 10. 🧾 Database Design

### Event Table

* company
* stage
* date (UTC)
* time
* venue
* confidence
* status
* reviewReason

---

### EventUpdates Table

* event_id
* field
* old_value
* new_value
* timestamp

---

## 11. 🧪 Testing Strategy

### Types of Tests

* unit tests (extraction, matching, event logic)
* integration test (POST /email)

---

### Key Principles

#### 1. Test Service Layer

```text
service → business logic
repository → NOT tested
```

---

#### 2. Mock Dependencies

Example:

```ts
jest.mock("../../matching/matching.service")
jest.mock("../../event/event.service")
```

---

#### 3. Avoid DB in Unit Tests

```text
NO Prisma execution in unit tests
```

---

#### 4. Isolated Tests

```ts
beforeEach(() => {
  jest.clearAllMocks();
});
```

---

## 12. 🧠 Key Design Principles

### 1. Defensive Design

* handle missing/invalid inputs safely

---

### 2. Separation of Concerns

| Layer      | Responsibility |
| ---------- | -------------- |
| extraction | data           |
| confidence | trust          |
| service    | decision       |
| repository | persistence    |

---

### 3. Trust-Based Decisions

```text
data + confidence → action
```

---

### 4. Observability

* explanation in matching
* audit logs for updates

---

## 13. 🔥 System Evolution

### Before

```text
rule-based pipeline
```

---

### After

```text
intelligent decision system
```

---

## 14. 🚀 Future Improvements

* review dashboard (UI)
* manual correction system
* confidence analytics
* embeddings for semantic matching
* async processing (queues)

---

## 15. 🎯 Interview Summary

> I built a backend system that processes unstructured placement emails and converts them into structured events.
> I implemented confidence scoring to measure extraction reliability, and used it to drive safe updates and intelligent matching.
> The system also supports explainable decisions and a low-confidence review flow to ensure data integrity.

---
