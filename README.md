# 🚀 Placement Tracker

An **AI-powered Placement Intelligence System** that processes placement-related emails, extracts structured information, and intelligently manages event tracking.

> ⚡ Built using production-grade backend principles: deterministic parsing, confidence-based decisions, intent-aware updates, and robust testing.

---

## 🧠 Problem

Placement emails are:

* unstructured
* inconsistent
* difficult to track manually

👉 Result: missed deadlines, confusion, and duplicate tracking.

---

## 🎯 Solution

This system:

* extracts structured data from emails
* prevents duplicate events
* intelligently updates existing records
* handles uncertainty using confidence-based decisions

---

## ⚙️ Tech Stack

* **Backend:** Node.js, Express, TypeScript
* **Database:** PostgreSQL (Docker)
* **ORM:** Prisma
* **Testing:** Jest + ts-jest
* **AI (Optional):** OpenAI API
* **Architecture:** Modular (feature-based)

---

## 🏗️ System Architecture

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
PostgreSQL
```

---

## 🔄 End-to-End Flow

1. Receive email via API
2. Clean and normalize text
3. Extract structured data
4. Compute confidence score
5. Match against existing events
6. Decision layer:

   * update event
   * create new event
   * create review event
7. Store audit logs
8. Return response

---

## 🔥 Key Features

---

### 📧 1. Email Processing Pipeline

* Endpoint: `POST /email`
* Fully automated processing pipeline

---

### 🧩 2. Deterministic Extraction System

* Regex-based (no AI dependency)
* Handles real-world formats:

| Field | Examples                            |
| ----- | ----------------------------------- |
| Date  | `20th Aug`, `tomorrow`, `next week` |
| Time  | `10 AM`, `5 in evening`             |
| Venue | HackerRank, Zoom, Auditorium        |

---

### 🧠 3. Hybrid AI + Regex (Optional)

* AI improves flexibility
* Regex ensures reliability
* Controlled via `USE_AI`

---

### 🗓️ 4. Timezone-Safe Design

* DB stores **UTC**
* Business logic uses **IST**
* Prevents date mismatch bugs

---

### 🔑 5. Smart Event Identity

```text
eventKey = company | stage | IST_date
```

* prevents duplicates
* ensures consistent matching

---

### 🔍 6. Confidence-Aware Matching (🔥 Advanced)

Matching evolved from:

```text
first match wins ❌
```

to:

```text
best match wins (scoring-based) ✅
```

Scoring uses:

* date proximity
* stage match
* confidence alignment

---

### 🧠 7. Confidence Scoring System

Each extraction produces:

```ts
{
  data,
  confidence: number
}
```

Used for:

* update decisions
* matching quality
* review detection

---

### 🔄 8. Confidence-Aware Updates

```ts
if (newConfidence < existingConfidence) {
  skip update;
}
```

Prevents:

* data corruption
* overwriting good data with weak input

---

### ⚠️ 9. Low-Confidence Review System (🔥 Product Feature)

If extraction is unreliable:

```ts
status: "review"
reviewReason: "Low confidence extraction"
```

Behavior:

* ❌ no update to existing event
* ✅ safe event creation
* enables human review

---

### 🧠 10. Explainable Matching

Each match includes reasoning:

```ts
{
  explanation: "Exact date match + strong confidence alignment"
}
```

Benefits:

* debugging
* transparency
* interview clarity

---

### 🧠 11. Intent-Aware Data Handling

Handles:

| Scenario         | Behavior           |
| ---------------- | ------------------ |
| missing field    | preserve old value |
| explicit invalid | clear value        |

Using:

```ts
VenueMeta = {
  value,
  isExplicit
}
```

---

### 🔄 12. Intelligent Update Detection

Updates only when:

```ts
value exists && value changed
```

---

### 🧾 13. Audit Logging

All changes stored in:

* `event_updates`

Tracks:

* reschedules
* time changes
* venue changes

---

## 🗃️ Database Design

### Event

* company
* stage
* date (UTC)
* time
* venue
* confidence
* status
* reviewReason

---

### EventUpdates

* event_id
* field
* old_value
* new_value
* timestamp

---

## 🧪 Testing

### Coverage

* Unit tests:

  * extraction
  * matching
  * event logic

* Integration:

  * full `/email` pipeline

---

### Testing Principles

* test service layer only
* mock all dependencies
* no Prisma in unit tests
* isolate tests

---

## 📁 Project Structure

```text
backend/
├── src/
│   ├── modules/
│   │   ├── email/
│   │   ├── extraction/
│   │   ├── event/
│   │   ├── matching/
│   ├── shared/
│   ├── lib/
│   └── app.ts
├── prisma/
└── docker-compose.yml
```

---

## 🧠 Design Principles

* Deterministic > probabilistic
* Trust-aware decisions
* Defensive programming
* Modular architecture
* No undefined in API responses
* Intent-aware data modeling

---

## 📘 Detailed Design

See [SYSTEM_DESIGN.md](./backend/SYSTEM_DESIGN.md) for full architecture and design decisions.

---

## 🚀 Getting Started

```bash
git clone https://github.com/YOUR_USERNAME/Placement-Tracker.git
cd backend
npm install
```

### Setup `.env`

```
DATABASE_URL=your_postgres_url
USE_AI=false
```

```bash
docker-compose up -d
npx prisma migrate dev
npm run dev
```

---

## 📌 API

### POST /email

```json
{
  "body": "email content"
}
```

---

## 📈 Future Improvements

* Review dashboard
* Manual correction system
* Email ingestion (Gmail)
* Confidence analytics
* Semantic matching (embeddings)

---

## 🏆 Resume Description

> Built a production-grade backend system that processes unstructured placement emails into structured events using deterministic parsing, confidence-based decision making, intelligent matching, and a low-confidence review system, ensuring high data integrity and reliability.

---

## 👨‍💻 Author

**Ankit Kumar Anand**
B.Tech CSE | Backend & Systems

---

## ⭐ Support

If you like this project, give it a star ⭐
