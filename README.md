<div align="center">
  <img src="assets/gitwalk_banner.png" alt="GitWalk Banner" width="100%" />
</div>

<h1 align="center">GitWalk</h1>

<div align="center">

![Python](https://img.shields.io/badge/Python-3.10%2B-3776ab?style=for-the-badge&logo=python&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![FastAPI](https://img.shields.io/badge/FastAPI-0.100+-009688?style=for-the-badge&logo=fastapi&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-Built--in-003B57?style=for-the-badge&logo=sqlite&logoColor=white)

</div>

---

## 📌 Project Problem Challenge
Managing distributed data collection often forces a choice between familiar but disconnected tools (like Microsoft Excel) and centralized but complex database systems. Integrating the two usually requires significant overhead: installing ODBC drivers, configuring complex database credentials, running external database servers, and maintaining custom sync scripts. **GitWalk** challenges this paradigm by offering a zero-setup solution where users can continue using native Excel while having their data instantly and painlessly synchronized to a centralized SQLite database.

## 📖 Project Description
**GitWalk** is an innovative live-synchronization platform that provides real-time, bi-directional data flow between Microsoft Excel Desktop and a centralized SQLite backend. It requires **zero external database setup**. Users simply drag-and-drop their existing `.xlsx` files into a premium dark-themed web interface. The system automatically provisions a dynamic SQLite table and injects an Office Web Add-in into the file. Once opened in Excel, every cell edit is instantaneously mirrored in the backend database.

## 🏗️ Project Architecture

<div align="center">
  <img src="assets/architecture_concept.png" alt="Architecture Concept" width="80%" />
</div>

The architecture leverages a lightweight yet robust modern stack:
* **Frontend UI (React 18)**: Handles file uploads and Office.js Add-in side-loading.
* **Backend API (FastAPI)**: Serves endpoints for file provisioning and real-time synchronization.
* **Database (SQLite)**: Auto-provisioned tables to store the Excel data directly (no servers needed).
* **Client (Excel Add-in)**: Uses Office.js to listen to worksheet changes and pushes them to the backend.

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                        USER WORKFLOW                                       │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ┌──────────────┐     POST /upload      ┌──────────────┐                  │
│  │  Browser UI  │ ──────────────────>   │  FastAPI     │                  │
│  │  (React)     │ <──────────────────   │  Backend     │                  │
│  │  Port 3000   │   Download .xlsx      │  Port 8000   │                  │
│  └──────────────┘                        └──────┬───────┘                  │
│                                                 │                          │
│  ┌──────────────┐     POST /sync         ┌──────┴───────┐                  │
│  │ Excel Desktop│ ──────────────────>   │   SQLite     │                  │
│  │ + Taskpane   │   Cell-level edits    │  queue_board │                  │
│  │ (Office.js)  │                       │    .db       │                  │
│  └──────────────┘                        └──────────────┘                  │
└────────────────────────────────────────────────────────────────────────────┘
```

## 📂 Project Folder Structure

```text
GitWalk/
├── backend/                  # FastAPI Application
│   ├── app/                  # API Logic & Setup
│   │   ├── main.py           # Core FastAPI endpoints
│   │   ├── database.py       # SQLite manager & provisioning
│   │   ├── openxml_injector.py # OpenXML engine for .xlsx manipulation
│   │   └── schemas.py        # Request/Response models (Pydantic)
│   ├── queue_board.db        # Automatically created SQLite database
│   └── requirements.txt      # Python dependencies
├── frontend/                 # React UI & Office Add-in
│   ├── public/               # Static assets & manifest
│   │   ├── manifest.xml      # Office Web Add-in manifest
│   │   └── index.html        # App HTML shell
│   ├── src/                  # React Source Code
│   │   ├── components/       # Reusable UI components
│   │   ├── services/         # API integration
│   │   ├── App.jsx           # Main React Application
│   │   └── taskpane.jsx      # Office.js embedded entry point
│   ├── package.json          # Node.js dependencies
│   └── webpack.config.js     # Webpack build configurations
└── README.md                 # Project Documentation
```

## 🔗 API Path

### Base URL: `http://localhost:8000`

| Endpoint | Method | Description | Request | Response |
|----------|--------|-------------|---------|----------|
| `/api/v1/upload-and-provision` | `POST` | Uploads an `.xlsx` file, provisions DB tables, and returns an add-in injected Excel file. | `multipart/form-data` | Configured `.xlsx` file download |
| `/api/v1/realtime-sync` | `POST` | Syncs cell-level edits from Excel to the backend SQLite DB in real time. | JSON Body (Cell details) | Status Success JSON |
| `/health` | `GET` | API Healthcheck to verify the backend server is running. | None | `{"status": "ok"}` |

## 🚀 How to Run the Project

### Prerequisites
- **Python 3.10+** (with pip)
- **Node.js 18+** (with npm)
- **Microsoft Excel Desktop** (for taskpane / add-in testing)

### 1. Backend Setup
```bash
cd backend

# Create and activate virtual environment
python -m venv venv
# On Windows:
venv\Scripts\activate
# On macOS/Linux:
# source venv/bin/activate

# Install requirements
pip install -r requirements.txt

# Run the FastAPI server
uvicorn app.main:app --reload --port 8000
```
*Backend runs on `http://localhost:8000` with Swagger UI at `http://localhost:8000/docs`.*

### 2. Frontend Setup
```bash
cd frontend

# Install Node dependencies
npm install

# Start the React development server (trusted HTTPS on port 3000)
npm.cmd start
```
*Frontend UI runs on `https://localhost:3000`. Windows may prompt you to trust the `Developer CA for Microsoft Office Add-ins` certificate.*

### 3. Usage Steps
1. Navigate to **`https://localhost:3000`** in your browser.
2. Drag-and-drop or upload your `.xlsx` file. Click "Upload & Provision" to download a modified version (`configured_<TABLE_ID>_<filename>.xlsx`).
3. Open the downloaded file in **Excel Desktop**.
4. Sideload the add-in (Insert → My Add-ins → Upload My Add-in) using `frontend/public/manifest.xml`. The SQLite LiveSync taskpane will open.
5. Start editing any cell in the configured table. Your changes will automatically sync to the `queue_board.db` SQLite database in real time!

### 4. Verify in Database
```bash
py -m sqlite3 backend/queue_board.db

# List tables
.tables

# Query your data
SELECT * FROM QUEUE_BOARD_XXXXXXXX LIMIT 10;
```

## 🛠️ Necessary Details
- **SQL Injection Prevention**: All interactions with the database utilize parameterized bindings (`?`) ensuring security.
- **Dynamic Table Creation**: During upload, column names are sanitized automatically, and an auto-incrementing `ROW_ID` is applied to track records natively.
- **Trust Developer Certs**: The React frontend requires HTTPS for the Office Add-in. On the first run, ensure you trust the `Developer CA for Microsoft Office Add-ins` when prompted.
- **Office Web Add-in Manifest**: An OpenXML Injection automatically embeds an Office Web Add-in manifest directly into the `.xlsx` file structure.
- **License**: MIT
