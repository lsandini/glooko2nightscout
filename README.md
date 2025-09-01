# glooko2nightscout# Glooko CGM Reader for Nightscout

A Node.js script that fetches CGM (Continuous Glucose Monitor) data from Glooko and converts it to Nightscout-compatible format.

## Features

### 🔐 Authentication
- Browser-based authentication using Puppeteer
- Automatically extracts patient ID from the Glooko dashboard
- Maintains session for 23 hours to minimize re-authentication
- Supports both EU and US Glooko environments

### 📊 Data Fetching
- Dual API support with automatic fallback:
  - Primary: External API (`https://externalapi.glooko.com`)
  - Fallback: Internal Graph API (`https://eu.api.glooko.com`)
- Fetches CGM readings from three glucose ranges:
  - `cgmLow`: Hypoglycemic readings (< 4.0 mmol/L)
  - `cgmNormal`: Normal range readings (4.0-10.0 mmol/L)
  - `cgmHigh`: Hyperglycemic readings (> 10.0 mmol/L)

### 🔄 Smart Synchronization
- Checkpoint-based incremental fetching
- Tracks last reading timestamp and GUID
- Only fetches new data on subsequent runs
- Force full fetch option available

### 📈 Data Processing
- Converts glucose values from mmol/L to mg/dL (factor: 18.0143)
- Corrects timezone discrepancies in timestamps
- Transforms data to Nightscout SGV (Sensor Glucose Value) format
- Preserves both mmol/L and mg/dL values

## Configuration

Create a `.env` file with your Glooko credentials:

```env
GLOOKO_EMAIL=your-email@example.com
GLOOKO_PASSWORD=your-password
GLOOKO_ENV=eu  # or "us" for US users
GLOOKO_TZ_OFFSET=0  # Timezone offset in milliseconds
GLOOKO_DEBUG=true  # Enable debug logging
```

## Installation

```bash
# Install dependencies
npm install puppeteer axios dotenv

# Configure credentials
cp .env.example .env
# Edit .env with your Glooko credentials
```

## Usage

### Command Line Options

```bash
# Fetch latest data (incremental from last checkpoint)
node glooko-cgm-reader.js

# Fetch specific time range
node glooko-cgm-reader.js --hours 3

# Force full fetch (ignore checkpoint)
node glooko-cgm-reader.js --full

# Export data to JSON file
node glooko-cgm-reader.js --export cgm-data.json

# Enable debug logging
node glooko-cgm-reader.js --debug

# Combine options
node glooko-cgm-reader.js --debug --hours 24 --full --export
```

### Output Format

The script displays a summary with glucose readings in mmol/L and local time:

```
📊 FETCH SUMMARY (Helsinki Time, mmol/L)
==========================================
✅ Success: 190 readings retrieved
⏱️  Execution time: 17.31s
📈 Latest: 7.5 mmol/L @ 31/08/2025, 16.46.32
📉 Oldest: 9.2 mmol/L @ 31/08/2025, 1.01.31
➡️  Trend: NONE

🩸 All readings (mmol/L, Helsinki time):
   1. 7.5 mmol/L @ 31/08/2025, 16.46.32
   2. 7.7 mmol/L @ 31/08/2025, 16.41.34
   3. 7.8 mmol/L @ 31/08/2025, 16.36.32
   ... and 187 more
```

## Data Structures

### Nightscout Entry Format

Each CGM reading is converted to Nightscout-compatible format:

```json
{
  "type": "sgv",
  "sgv": 135,                              // Glucose in mg/dL
  "sgv_mmol": 7.5,                        // Glucose in mmol/L
  "date": 1756648592000,                  // Unix timestamp (milliseconds)
  "dateString": "2025-08-31T13:46:32.000Z",
  "localTime": "31/08/2025, 16.46.32",    // Local time display
  "direction": "NONE",                     // Trend arrow (if available)
  "device": "glooko-cgm",
  "glookoGuid": "glooko_1756655192_7.5"
}
```

### Checkpoint File

The script maintains state in `glooko-checkpoint.json`:

```json
{
  "lastGuid": "glooko_1756655192_7.5",
  "lastReadingTime": "2025-08-31T15:46:32.000Z",
  "patientId": "eu-west-1-blue-dovetail-3011",
  "savedAt": "2025-08-31T14:17:42.622Z"
}
```

## API Response Structure

The Glooko Graph API returns data organized by glucose ranges:

```json
{
  "series": {
    "cgmLow": [{
      "x": 1756655192,                     // Unix timestamp (seconds)
      "y": 3.5,                            // Glucose value in mmol/L
      "value": 6305,                       // Internal encoding
      "timestamp": "2025-08-31T15:46:32.000Z",
      "mealTag": "none",
      "calculated": false
    }],
    "cgmNormal": [...],
    "cgmHigh": [...]
  }
}
```

## Export Format

When using `--export`, data is saved as:

```json
{
  "exportedAt": "2025-08-31T14:17:42.622Z",
  "source": "Glooko",
  "patientId": "eu-west-1-blue-dovetail-3011",
  "count": 190,
  "entries": [
    {
      "type": "sgv",
      "sgv": 135,
      "sgv_mmol": 7.5,
      "date": 1756648592000,
      "dateString": "2025-08-31T13:46:32.000Z",
      "localTime": "31/08/2025, 16.46.32",
      "direction": "NONE",
      "device": "glooko-cgm"
    }
  ]
}
```

## Integration with Nightscout

The script can be integrated with Nightscout in several ways:

1. **Direct Upload**: Add functionality to POST entries to Nightscout API
2. **Scheduled Job**: Run via cron every 5-15 minutes
3. **Docker Container**: Deploy as a containerized service
4. **nightscout-connect Module**: Replace the existing Glooko integration

Example integration code:
```javascript
const uploadToNightscout = async (entries) => {
  const crypto = require('crypto');
  await axios.post(`${NIGHTSCOUT_URL}/api/v1/entries`, entries, {
    headers: {
      'API-SECRET': crypto.createHash('sha1').update(API_SECRET).digest('hex'),
      'Content-Type': 'application/json'
    }
  });
};
```

## Class Structure

The script is built around the `GlookoCGMReader` class with these main methods:

- `authenticate()` - Handles browser-based login and session management
- `fetchCGMReadings()` - Retrieves CGM data from Glooko APIs
- `transformToNightscout()` - Converts Glooko data to Nightscout format
- `getLatestCGMData()` - Main method that orchestrates the full process
- `saveCheckpoint()` / `loadCheckpoint()` - Manages incremental fetching
- `exportToFile()` - Exports data to JSON file

## Dependencies

- **puppeteer** - Browser automation for authentication
- **axios** - HTTP client for API calls
- **dotenv** - Environment variable management
- **Node.js** - Runtime (v18+ recommended)

## Environment Support

Supports multiple Glooko regions:
- EU: `https://eu.my.glooko.com`
- US: `https://my.glooko.com`
- DE: `https://de.my.glooko.com`

## Error Handling

- Automatic retry with exponential backoff
- Session refresh on authentication errors
- Fallback API when primary fails
- Detailed debug logging when enabled

## Performance

- Typical execution time: 15-20 seconds
- Incremental fetches: 5-10 seconds
- Session reuse reduces authentication overhead
- Checkpoint system minimizes API calls

---

*A production-ready solution for fetching CGM data from Glooko and converting it to Nightscout format, with support for incremental synchronization and multiple Glooko environments.*