# Glooko CGM Reader for Nightscout

A comprehensive Node.js script that fetches CGM (Continuous Glucose Monitor) data from Glooko and converts it to Nightscout-compatible format with integrated user profile management.

## Core Features

### 🔐 Authentication & Session Management
- **Browser-based Authentication**: Uses Puppeteer to automate Glooko web login
- **Patient ID Extraction**: Automatically extracts user identifier from dashboard JavaScript variables
- **Session Persistence**: Maintains authentication cookies for 23 hours to minimize re-logins
- **Multi-region Support**: Automatically detects and routes to EU/US/DE Glooko environments

### 👤 User Profile Integration
- **Real-time Profile Data**: Fetches comprehensive user profile and preferences via `/api/v3/session/users`
- **Glucose Unit Detection**: Automatically handles mmol/L vs mg/dL based on user's configured preference
- **Target Range Extraction**: Retrieves user's personalized glucose targets and meal timing preferences
- **Device Connection Status**: Real-time monitoring of connected CGM devices and sync status

### 📊 CGM Data Fetching
- **Internal Graph API**: Uses Glooko's `/api/v3/graph/data` endpoint with cookie-based authentication
- **Multi-range Data**: Fetches CGM readings from three glucose categories:
  - `cgmLow`: Hypoglycemic readings
  - `cgmNormal`: Normal range readings  
  - `cgmHigh`: Hyperglycemic readings
- **Intelligent Time Ranges**: Supports both full day fetches and incremental updates

### 🔄 Smart Synchronization
- **Checkpoint-based Tracking**: Maintains state in `glooko-checkpoint.json` for incremental fetching
- **Last Reading Persistence**: Tracks most recent reading timestamp and generated GUID
- **Incremental Updates**: Only fetches new data since last successful run
- **Force Full Fetch**: Option to override checkpoint and fetch complete time range

### 📈 Data Processing & Conversion
- **Automatic Unit Conversion**: Converts between mmol/L and mg/dL as needed (factor: 18.0143)
- **Timezone Correction**: Handles complex Glooko timezone labeling and adjusts to local time
- **Nightscout Transformation**: Converts to standard SGV (Sensor Glucose Value) format
- **Dual Value Preservation**: Maintains both original mmol/L and converted mg/dL values

## Configuration

Create a `.env` file with your Glooko credentials:

```env
GLOOKO_EMAIL=your-email@example.com
GLOOKO_PASSWORD=your-password
GLOOKO_ENV=eu  # Options: eu, us, de
```

## Installation

```bash
# Install required dependencies
npm install puppeteer axios dotenv

# Configure your credentials
cp .env.example .env
# Edit .env with your Glooko login details
```

## Usage

### Command Line Interface

```bash
# Basic incremental fetch
node glooko-cgm-reader.js

# Fetch specific time range
node glooko-cgm-reader.js --hours 24

# Force complete data refresh
node glooko-cgm-reader.js --full

# Export to JSON file
node glooko-cgm-reader.js --export readings.json

# Enable detailed debugging
node glooko-cgm-reader.js --debug

# Combined options
node glooko-cgm-reader.js --debug --hours 12 --export
```

### Sample Output

The script provides comprehensive output including user profile and CGM data:

```
📊 GLOOKO CGM DATA SUMMARY
===========================
👤 User: [User Name] ([COUNTRY])
📊 Units: mmol/L
🎯 Targets: 7.0-18.0 mmol/L
📱 Devices: None currently connected

✅ Success: 48 readings retrieved
⏱️  Execution time: 15.23s
📈 Latest: 8.2 mmol/L @ 01/09/2025, 10:15:30
📉 Oldest: 7.8 mmol/L @ 31/08/2025, 22:30:15
➡️  Trend: NONE

🩸 All readings (mmol/L, Helsinki time):
   1. 8.2 mmol/L @ 01/09/2025, 10:15:30
   2. 8.1 mmol/L @ 01/09/2025, 10:10:28
   3. 7.9 mmol/L @ 01/09/2025, 10:05:31
   ... and 45 more
```

## Data Structures

### User Profile Data

The script automatically extracts and utilizes user profile information:

```json
{
  "userProfile": {
    "name": "[User Name]",
    "country": "[country_code]",
    "meterUnits": "mmoll",
    "glucoseTargets": {
      "normalMin": 7.0,
      "beforeMealMax": 13.0,
      "afterMealMax": 18.0,
      "mealTimes": {
        "breakfast": 5.0,
        "lunch": 10.0,
        "dinner": 15.0,
        "midnightSnack": 21.0
      }
    }
  },
  "deviceStatus": {
    "connectedDevices": [],
    "hasData": false,
    "lastSyncTimestamps": {
      "cgmDevice": null,
      "meter": null,
      "pump": null
    }
  }
}
```

### Nightscout Entry Format

Each CGM reading is converted to standard Nightscout format:

```json
{
  "type": "sgv",
  "sgv": 148,
  "sgv_mmol": 8.2,
  "date": 1725177330000,
  "dateString": "2025-09-01T07:15:30.000Z",
  "localTime": "01/09/2025, 10:15:30",
  "direction": "NONE",
  "device": "glooko-cgm",
  "glookoGuid": "glooko_1725184530_8.2"
}
```

### Checkpoint Management

State is maintained in `glooko-checkpoint.json`:

```json
{
  "lastGuid": "glooko_[timestamp]_[value]",
  "lastReadingTime": "2025-09-01T07:15:30.000Z",
  "patientId": "[obfuscated-patient-id]",
  "savedAt": "2025-09-01T07:18:45.123Z"
}
```

## API Integration Details

### Authentication Flow
1. **Web Login**: Puppeteer navigates to Glooko login page
2. **Credential Submission**: Automated form filling and submission
3. **Session Cookie Extraction**: Captures authentication cookies from browser
4. **Patient ID Parsing**: Extracts user identifier from dashboard JavaScript
5. **Profile Validation**: Calls `/api/v3/session/users` to verify session and get profile

### Data Retrieval Process
1. **Profile Check**: Determines user preferences and connected devices
2. **Time Range Calculation**: Establishes fetch window based on checkpoint or parameters
3. **Graph API Query**: Requests CGM data via `/api/v3/graph/data` endpoint
4. **Multi-series Aggregation**: Combines cgmLow, cgmNormal, and cgmHigh arrays
5. **Data Transformation**: Converts to Nightscout format with proper units and timestamps

### Raw API Response Structure

Glooko's graph API returns structured time-series data:

```json
{
  "series": {
    "cgmLow": [{
      "x": 1725184530,
      "y": 3.8,
      "value": 6843.434,
      "timestamp": "2025-09-01T07:15:30.000Z",
      "mealTag": "none",
      "calculated": false
    }],
    "cgmNormal": [...],
    "cgmHigh": [...]
  }
}
```

## Export Functionality

When using `--export`, comprehensive data is saved including user context:

```json
{
  "exportedAt": "2025-09-01T07:20:15.456Z",
  "source": "Glooko",
  "patientId": "[obfuscated-patient-id]",
  "userProfile": {
    "name": "[User Name]",
    "country": "[country]",
    "meterUnits": "mmoll",
    "glucoseTargets": {...}
  },
  "deviceStatus": {...},
  "count": 48,
  "entries": [...]
}
```

## Class Architecture

The `GlookoCGMReader` class provides a complete integration solution:

### Core Methods
- `authenticate()` - Handles web login and cookie extraction
- `fetchUserProfile()` - Retrieves user profile and device status
- `fetchCGMReadings()` - Queries CGM data from graph API
- `transformToNightscout()` - Converts data to Nightscout SGV format
- `getLatestCGMData()` - Orchestrates complete fetch cycle
- `saveCheckpoint()` / `loadCheckpoint()` - Manages incremental sync state
- `exportToFile()` - Saves data with full context

### Helper Methods
- `getTrendArrow()` - Maps trend indicators to Nightscout format
- `getWebUrl()` / `getApiUrl()` - Regional endpoint detection
- `log()` - Contextual debug logging

## Environment & Regional Support

### Supported Regions
- **EU**: `https://eu.my.glooko.com` → `https://eu.api.glooko.com`
- **US**: `https://my.glooko.com` → `https://api.glooko.com`
- **DE**: `https://de.my.glooko.com` → `https://de.api.glooko.com`

### Device Compatibility
The script automatically detects and reports connection status for:
- Eversense CGM systems
- iGlucose monitors
- Insulet/Omnipod systems
- Abbott CSV imports
- Medtronic closed-loop systems
- Control IQ enabled devices

## Error Handling & Reliability

### Robust Error Management
- **Authentication Retry**: Automatic session refresh on 401/403 errors
- **Exponential Backoff**: Progressive delays between retry attempts
- **Connection Timeout**: 30-second API call timeouts with retry
- **Data Validation**: Filters invalid readings and handles edge cases

### Debug Capabilities
- **Comprehensive Logging**: Detailed execution trace when `--debug` enabled
- **API Response Inspection**: Raw data structure display for troubleshooting
- **Browser Console Capture**: Puppeteer console message forwarding
- **Timing Analysis**: Execution performance metrics

## Performance Characteristics

### Typical Execution Times
- **Full Authentication**: 15-20 seconds (includes browser startup)
- **Cached Session**: 5-8 seconds (reuses existing cookies)
- **Incremental Fetch**: 3-5 seconds (small data sets)
- **Large Data Sets**: 20-30 seconds (24+ hours of readings)

### Resource Usage
- **Memory**: ~100MB during Puppeteer operation
- **Network**: 2-5 API calls per execution
- **Storage**: Minimal (checkpoint file only)

## Integration with Nightscout

### Direct Upload Pattern
```javascript
const { GlookoCGMReader } = require('./glooko-cgm-reader');

const uploadToNightscout = async () => {
  const reader = new GlookoCGMReader(config);
  const result = await reader.getLatestCGMData();
  
  if (result.success && result.entries.length > 0) {
    // POST to Nightscout API
    await axios.post(`${NIGHTSCOUT_URL}/api/v1/entries`, result.entries, {
      headers: {
        'API-SECRET': hashedSecret,
        'Content-Type': 'application/json'
      }
    });
  }
};
```

### Scheduled Execution
```bash
# Add to crontab for 5-minute intervals
*/5 * * * * cd /path/to/cgm-reader && node glooko-cgm-reader.js
```

## Dependencies

- **puppeteer** (^21.0.0) - Browser automation for web authentication
- **axios** (^1.5.0) - HTTP client for API communication  
- **dotenv** (^16.3.0) - Environment variable management
- **Node.js** (v18+) - JavaScript runtime

---

*A production-ready solution for comprehensive Glooko-Nightscout integration with intelligent user profile management, multi-region support, and robust error handling.*