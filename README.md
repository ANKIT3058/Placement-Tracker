# 🚀 Placement Tracker

An **AI-powered Placement Intelligence System** that converts unstructured placement emails into structured, trackable events.

> ⚡ Built with production-grade principles: confidence-aware decisions, intent-aware updates, and human-in-the-loop review.

---

## 🧠 Problem

Placement emails are:

* unstructured
* inconsistent
* hard to track manually

👉 Result: missed deadlines, duplicate tracking, confusion

---

## 🎯 Solution

This system:

* extracts structured data from emails
* intelligently updates or creates events
* prevents duplicates using smart matching
* handles uncertainty using confidence scoring

---

## 🖥️ Demo Flow

1. Paste placement email
2. System extracts structured data
3. High confidence → auto update
4. Low confidence → sent to review
5. Manual correction → confirmed event

---

## ⚙️ Tech Stack

* **Backend:** Node.js, Express, TypeScript
* **Database:** PostgreSQL (Docker)
* **ORM:** Prisma
* **Frontend:** React, TypeScript
* **Testing:** Jest
* **AI (Optional):** OpenAI

---

## 🏗️ Architecture

```text
Email Input
   ↓
Extraction (Regex + AI)
   ↓
Validation Layer
   ↓
Confidence Scoring
   ↓
Matching System
   ↓
Decision Engine
   ↓
→ Update Event
→ Review Queue
   ↓
PostgreSQL
```

---

## 🔥 Key Features

### 🧠 Confidence-Aware System (Core Innovation)

* Each extraction has a **confidence score**
* System decisions are based on reliability, not assumptions

```ts
if (newConfidence < existingConfidence) {
  skip update;
}
```

---

### 🔍 Intelligent Matching (No Duplicates)

* Exact match using `eventKey`

* Soft match using scoring:

* date proximity

* stage match

* confidence

👉 ensures correct event updates

---

### ⚠️ Human-in-the-Loop Review

Low-confidence extraction:

* ❌ does NOT update existing data
* ✅ creates review event

```ts
status: "review"
reviewReason: "Low confidence extraction"
```

---

### 🧠 Intent-Aware Updates

Distinguishes:

| Scenario         | Behavior           |
| ---------------- | ------------------ |
| Missing field    | Preserve old value |
| Explicit invalid | Clear value        |

---

### 🧾 Audit Logging

Tracks all updates:

* time changes
* venue updates
* reschedules

---

## 🗃️ Database

### Event

* company
* stage
* date
* time
* venue
* confidence
* status

### EventUpdate

* field changes
* old → new values
* timestamp

---

## 🧪 Testing

* Unit tests for extraction, matching, logic
* Integration tests for full pipeline
* Dependency mocking (no DB in unit tests)

---

## 📁 Project Structure

```text
backend/
  src/
    modules/
      email/
      extraction/
      event/
      matching/
    shared/
    lib/
```

---

## 🚀 Getting Started

```bash
git clone https://github.com/YOUR_USERNAME/Placement-Tracker.git
cd backend
npm install
```

### Setup

```env
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

## 📈 Future Scope

* Gmail integration
* Notification system
* Confidence analytics
* Multi-event extraction

---

## 🧠 Key Design Principles

* Deterministic > probabilistic
* Never trust raw extraction
* Preserve high-confidence data
* Handle uncertainty explicitly
* Safe failure > incorrect updates

---

## 🏆 Resume Summary

> Built a production-grade backend system that processes unstructured placement emails into structured events using confidence-based decision making, intelligent matching, and a human-in-the-loop review system.

---

## 👨‍💻 Author

**Ankit Kumar Anand**
B.Tech CSE | Backend & Systems

---

⭐ If you like this project, consider giving it a star!
