# ExcelSQLiteLiveSync

> Real-time bi-directional synchronization between Microsoft Excel Desktop and a centralized SQLite database — **zero external database setup required**.

![Architecture](https://img.shields.io/badge/Architecture-FastAPI%20%2B%20React%20%2B%20SQLite-6366f1?style=for-the-badge)
![Python](https://img.shields.io/badge/Python-3.10%2B-3776ab?style=for-the-badge&logo=python&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black)

---

## Architecture

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                        USER WORKFLOW                                       │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ┌──────────────┐     POST /upload      ┌──────────────┐                  │
│  │  Browser UI   │ ──────────────────>   │  FastAPI      │                  │
│  │  (React App)  │ <──────────────────   │  Backend      │                  │
│  │  Port 3000    │   Download .xlsx      │  Port 8000    │                  │
│  └──────────────┘                        └──────┬───────┘                  │
│                                                  │                          │
│  ┌──────────────┐     POST /sync         ┌──────┴───────┐                  │
│  │ Excel Desktop │ ──────────────────>   │   SQLite      │                  │
│  │ + Taskpane    │   Cell-level edits    │  queue_board  │                  │
│  │ (Office.js)   │                       │    .db        │                  │
│  └──────────────┘                        └──────────────┘                  │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

## Features

- 📁 **Drag & Drop Upload** — Upload any `.xlsx` file via a premium dark-themed web UI
- 🗄️ **Auto-Provisioning** — Dynamically creates SQLite tables with sanitized column names and auto-incrementing `ROW_ID`
- 📦 **OpenXML Injection** — Embeds an Office Web Add-in manifest directly into the `.xlsx` file structure
- ⚡ **Real-Time Sync** — Cell edits in Excel Desktop fire instantly to the SQLite backend via the embedded taskpane
- 🔒 **SQL Injection Protection** — All queries use parameterized binding (`?` placeholders)
- 🚀 **Zero Setup** — SQLite is built into Python. No database server, no drivers, no credentials

---

## Quick Start

### Prerequisites

- **Python 3.10+** (with pip)
- **Node.js 18+** (with npm)
- **Microsoft Excel Desktop** (for taskpane / add-in testing)

### 1. Start the Backend

```bash
cd backend

# Create virtual environment (recommended)
python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # macOS/Linux

# Install dependencies
pip install -r requirements.txt

# Start the server
uvicorn app.main:app --reload --port 8000
```

The API is now running at **http://localhost:8000**. Visit http://localhost:8000/docs for interactive Swagger UI.

### 2. Start the Frontend

```bash
cd frontend

# Install dependencies
npm install

# Start the dev server (trusted HTTPS on port 3000)
npm.cmd start
```

The upload app opens at **https://localhost:3000**. On the first run, Windows
may ask once whether to trust `Developer CA for Microsoft Office Add-ins`.
Later starts reuse and automatically renew that certificate.

---

## Usage

### Step 1: Upload Your Excel File

1. Open **https://localhost:3000** in your browser
2. Drag-and-drop (or click to select) your `.xlsx` file
3. Click **"Upload & Provision"**
4. A `configured_<TABLE_ID>_<filename>.xlsx` file will auto-download
5. The Table ID is embedded in the downloaded workbook and remembered locally

### Step 2: Open in Excel & Sync

1. Open the downloaded `configured_<TABLE_ID>_<filename>.xlsx` in **Excel Desktop**
2. If the add-in is not already registered, side-load the manifest once:
   - Go to **Insert** → **My Add-ins** → **Upload My Add-in**
   - Browse to `frontend/public/manifest.xml` (or use the one at `https://localhost:3000/manifest.xml`)
3. The **SQLite LiveSync** taskpane opens on the right
4. The taskpane reads the workbook's Table ID and starts listening automatically
5. Edit any single cell — changes sync to SQLite in real time!

### Step 3: Verify in SQLite

```bash
py -m sqlite3 C:\Projects\boardwalk-clone\excel-sqlite-sync\backend\queue_board.db

# List tables
.tables

# Query your data
SELECT * FROM QUEUE_BOARD_XXXXXXXX LIMIT 10;
```

---

## API Reference

### `POST /api/v1/upload-and-provision`

Upload an `.xlsx` file, create a SQLite table, inject the taskpane manifest, and return the modified file.

**Request:** `multipart/form-data` with `file` field

**Response:** Binary `.xlsx` file download with headers:
| Header | Description |
|---|---|
| `X-Table-ID` | Generated table name |
| `X-Row-Count` | Number of rows seeded |
| `X-Column-Count` | Number of columns |

### `POST /api/v1/realtime-sync`

Sync a single cell edit from Excel to SQLite.

**Request Body:**
```json
{
  "table_id": "QUEUE_BOARD_A1B2C3D4",
  "row_id": 1,
  "column_name": "EMPLOYEE_NAME",
  "new_value": "Jane Doe"
}
```

**Response:**
```json
{
  "status": "SUCCESS",
  "timestamp": "2025-01-15T10:30:00Z",
  "message": "Updated QUEUE_BOARD_A1B2C3D4.EMPLOYEE_NAME @ ROW_ID=1"
}
```

### `GET /health`

Health check endpoint. Returns `{"status": "ok"}`.

---

## Project Structure

```
excel-sqlite-sync/
├── backend/
│   ├── app/
│   │   ├── __init__.py           # Package marker
│   │   ├── main.py               # FastAPI endpoints
│   │   ├── database.py           # SQLite manager & dynamic provisioning
│   │   ├── openxml_injector.py   # .xlsx OpenXML manipulation engine
│   │   └── schemas.py            # Pydantic v2 request/response models
│   ├── queue_board.db            # Auto-created SQLite database
│   └── requirements.txt          # Python dependencies
├── frontend/
│   ├── public/
│   │   ├── manifest.xml          # Office Web Add-in manifest
│   │   ├── index.html            # Upload app HTML shell
│   │   └── taskpane.html         # Taskpane HTML shell (with Office.js)
│   ├── src/
│   │   ├── components/
│   │   │   ├── FileUploader.jsx  # Drag-and-drop upload component
│   │   │   ├── TaskpaneUI.jsx    # Office.js sync side panel
│   │   │   └── StatusBanner.jsx  # Animated status indicator
│   │   ├── services/
│   │   │   └── api.js            # API client helpers
│   │   ├── App.jsx               # Main upload application
│   │   ├── taskpane.jsx          # Office.js entry point
│   │   └── index.js              # Main app entry point
│   ├── package.json              # Node.js dependencies
│   └── webpack.config.js         # Webpack 5 build config
└── README.md
```

---

## License

MIT
