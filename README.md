# 🚀 Placement Tracker

An **AI-powered Placement Intelligence System** that processes placement-related emails, extracts structured information, and intelligently tracks and updates events.

---

## 🧠 Problem Statement

Placement emails are often:

* unstructured
* inconsistent
* hard to track manually

This system automates the process of:

* extracting important details
* organizing events
* detecting updates intelligently

---

## ⚙️ Tech Stack

* **Backend:** Node.js, Express, TypeScript
* **Database:** PostgreSQL (Docker)
* **ORM:** Prisma
* **AI (Optional):** OpenAI API
* **Architecture:** Modular, feature-based design

---

## 🔥 Key Features

### 📧 1. Email Processing Pipeline

* Endpoint: `POST /email`
* Accepts raw email text
* Cleans and processes content automatically

---

### 🧩 2. Deterministic Extraction System (Core)

* Regex-based extraction (no AI dependency)
* Handles:

  * Dates → `20th Aug`, `next week`, `tomorrow`
  * Time → `10 AM`, `around 5 in the evening`
  * Venue → HackerRank, Zoom, etc.
* Context-aware parsing (e.g., *"evening" → 17:00*)

---

### 🧠 3. Hybrid AI + Regex System

* AI used as **optional enhancement**
* Regex ensures **deterministic reliability**
* Feature-flag controlled (`USE_AI`)

---

### 🗓️ 4. Timezone-Safe Architecture (🔥)

* Database stores all dates in **UTC**
* Business logic uses **IST normalization**
* Prevents date drift issues

---

### 🔑 5. Smart Event Key System

```
eventKey = company | stage | IST_date
```

* Ensures uniqueness
* Prevents duplicate events

---

### 🔄 6. Intelligent Update Detection

Automatically detects and tracks changes in:

* Date
* Time
* Venue

Stored in:

* `event_updates` table

---

### 🧾 7. Event History Tracking

Maintains a log of all updates for audit and traceability.

---

## 🏗️ Architecture

```
email → extraction → parser → event service → database
```

### Folder Structure

```
backend/
├── src/
│   ├── modules/
│   │   ├── email/
│   │   ├── extraction/
│   │   ├── event/
│   ├── shared/
│   │   ├── utils/
│   ├── lib/
│   └── app.ts
├── prisma/
└── docker-compose.yml
```

---

## 🗃️ Database Design (Current)

### Implemented:

* `events`
* `event_updates`

### Planned (Incremental):

* `emails`
* `event_emails`
* `email_extractions`
* `companies`

---

## 🔁 Data Flow

1. Receive email via API
2. Clean and preprocess text
3. Extract structured data (regex + optional AI)
4. Normalize date (UTC)
5. Generate event key (IST)
6. Match existing event
7. Create or update event
8. Store changes

---

## 🧪 Example

### Input:

```json
{
  "body": "Amazon is hiring! OA will be held next week, 20th Aug around 5 in the evening on HackerRank."
}
```

### Output:

```json
{
  "company": "amazon",
  "stage": "OA",
  "date": "2026-08-20T00:00:00.000Z",
  "time": "17:00",
  "venue": "hackerrank",
  "eventKey": "amazon|OA|2026-08-20"
}
```

---

## 🚀 Getting Started

### 1. Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/Placement-Tracker.git
cd Placement-Tracker/backend
```

### 2. Install dependencies

```bash
npm install
```

### 3. Setup environment

Create `.env` file:

```
DATABASE_URL=your_postgres_url
OPENAI_API_KEY=your_key (optional)
USE_AI=false
```

### 4. Start database (Docker)

```bash
docker-compose up -d
```

### 5. Run Prisma

```bash
npx prisma migrate dev
```

### 6. Start server

```bash
npm run dev
```

---

## 📌 API

### POST /email

Process placement email

#### Request:

```json
{
  "body": "email content"
}
```

---

## 🧠 Design Principles

* Deterministic > probabilistic
* Simple > overengineered
* Modular > monolithic logic
* Fault-tolerant pipeline

---

## 📈 Future Improvements

* Smart event matching (fuzzy + reschedule detection)
* Confidence scoring system
* Email ingestion (Gmail integration)
* Dashboard & analytics
* User-specific filtering
* Notifications system

---

## 🏆 Resume Description

> Built an AI-powered placement tracking system that processes emails, extracts structured information using deterministic parsing and LLMs, and intelligently updates events using timezone-safe normalization and smart matching logic.

---

## 👨‍💻 Author

Ankit Kumar
B.Tech CSE | Backend & Systems Enthusiast

---

## ⭐ If you like this project

Give it a star ⭐ and feel free to contribute!
