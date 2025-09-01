#!/usr/bin/env node

// Load environment variables from .env file
require('dotenv').config();

const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * Glooko CGM Reader with incremental fetching support
 * Handles authentication via Puppeteer and maintains checkpoint for efficient data sync
 */
class GlookoCGMReader {
  constructor(config) {
    this.config = {
      email: config.email,
      password: config.password,
      env: config.env || 'eu',
      webUrl: config.webUrl || this.getWebUrl(config.env || 'eu'),
      apiUrl: config.apiUrl || this.getApiUrl(config.env || 'eu'),
      timezoneOffset: config.timezoneOffset || 0,
      checkpointFile: config.checkpointFile || 'glooko-checkpoint.json',
      debug: config.debug || false
    };
    
    this.session = null;
    this.sessionExpiry = null;
    this.lastGuid = null;
    this.lastReadingTime = null;
    this.userProfile = null;
    this.deviceStatus = null;
    
    this.log('🚀 Glooko CGM Reader initialized');
    this.log(`   Environment: ${this.config.env}`);
    this.log(`   Web URL: ${this.config.webUrl}`);
    this.log(`   API URL: ${this.config.apiUrl}`);
  }

  getWebUrl(env) {
    const urls = {
      'eu': 'https://eu.my.glooko.com',
      'us': 'https://my.glooko.com',
      'de': 'https://de.my.glooko.com'
    };
    return urls[env] || urls['eu'];
  }

  getApiUrl(env) {
    const urls = {
      'eu': 'https://eu.api.glooko.com',
      'us': 'https://api.glooko.com',
      'de': 'https://de.api.glooko.com'
    };
    return urls[env] || urls['eu'];
  }

  log(message, data = null) {
    if (this.config.debug) {
      console.log(`[${new Date().toISOString()}] ${message}`);
      if (data) {
        console.log(JSON.stringify(data, null, 2));
      }
    } else {
      // In non-debug mode, only show important messages
      if (message.includes('✅') || message.includes('❌') || message.includes('📊') || message.includes('🚀')) {
        console.log(message);
      }
    }
  }

  async authenticate(forceNew = false) {
    const now = Date.now();
    
    // Reuse session if still valid (23 hours) and not forcing new
    if (!forceNew && this.session && this.sessionExpiry && this.sessionExpiry > now) {
      this.log('♻️  Using cached session');
      return this.session;
    }

    this.log('🔐 Authenticating with Glooko...');
    
    let browser;
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--disable-gpu',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process'
        ]
      });

      const page = await browser.newPage();
      
      // Only capture important console logs if debugging
      if (this.config.debug) {
        page.on('console', msg => {
          const text = msg.text();
          // Only show important messages, filter out noise
          if (text.includes('window.patient:') || 
              text.includes('window.current_user_glooko_code:') ||
              text.includes('Looking for patient ID')) {
            this.log(`   Browser: ${text}`);
          }
        });
      }
      
      // Set user agent to avoid detection
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      // Set viewport
      await page.setViewport({ width: 1920, height: 1080 });
      
      // Navigate to login page
      this.log(`📄 Navigating to login page...`);
      await page.goto(`${this.config.webUrl}/users/sign_in`, {
        waitUntil: 'networkidle0',
        timeout: 30000
      });
      
      // Check if already on dashboard (existing session)
      if (page.url().includes('/dashboard')) {
        this.log('✅ Already logged in');
      } else {
        // Fill login form
        this.log('📝 Logging in...');
        await page.waitForSelector('input[name="user[email]"]', { timeout: 10000 });
        await page.type('input[name="user[email]"]', this.config.email, { delay: 100 });
        await page.type('input[name="user[password]"]', this.config.password, { delay: 100 });
        
        // Submit form
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }),
          page.click('input[type="submit"]')
        ]);
        
        // Check for login errors
        if (page.url().includes('/sign_in')) {
          const errorElement = await page.$('.alert-danger, .error');
          if (errorElement) {
            const errorText = await page.evaluate(el => el.textContent, errorElement);
            throw new Error(`Login failed: ${errorText}`);
          }
          throw new Error('Login failed: Still on sign-in page');
        }
        
        // If not on dashboard, navigate to it
        if (!page.url().includes('/dashboard')) {
          this.log('📍 Navigating to dashboard...');
          await page.goto(`${this.config.webUrl}/dashboard`, {
            waitUntil: 'networkidle0',
            timeout: 30000
          });
        }
      }
      
      // Wait for JavaScript to load patient data
      this.log('⏳ Extracting patient data...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Extract patient ID
      const patientId = await page.evaluate(() => {
        if (typeof console !== 'undefined' && console.log) {
          console.log('Looking for patient ID...');
          console.log('window.patient:', window.patient);
          console.log('window.current_user_glooko_code:', window.current_user_glooko_code);
        }
        
        return window.patient || 
               window.current_user_glooko_code || 
               window.patientId ||
               (window.current_user && window.current_user.glooko_code) ||
               (window.userData && window.userData.glookoCode);
      });
      
      if (!patientId) {
        // Try alternative extraction from page content
        const alternativeId = await page.evaluate(() => {
          const scripts = Array.from(document.querySelectorAll('script'));
          for (const script of scripts) {
            const match = script.textContent.match(/["']?patient["']?\s*:\s*["']([^"']+)["']/);
            if (match) return match[1];
          }
          return null;
        });
        
        if (!alternativeId) {
          throw new Error('Could not extract patient ID from page');
        }
        
        this.patientId = alternativeId;
      } else {
        this.patientId = patientId;
      }
      
      // Get all cookies
      const cookies = await page.cookies();
      const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      
      // Save session
      this.session = {
        patientId: this.patientId,
        cookieHeader,
        timestamp: now
      };
      
      this.sessionExpiry = now + (23 * 60 * 60 * 1000); // 23 hours
      
      this.log(`✅ Authentication successful! Patient ID: ${this.patientId}`);
      
      // Fetch user profile and device status
      await this.fetchUserProfile();
      
      return this.session;
      
    } catch (error) {
      this.log(`❌ Authentication failed: ${error.message}`);
      throw error;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  async fetchUserProfile() {
    if (!this.session) {
      throw new Error('Must authenticate before fetching user profile');
    }

    try {
      this.log('👤 Fetching user profile and device status...');
      
      const response = await axios.get(`${this.config.apiUrl}/api/v3/session/users`, {
        headers: {
          'Accept': 'application/json',
          'Cookie': this.session.cookieHeader,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': `${this.config.webUrl}/`,
          'Origin': this.config.webUrl
        },
        timeout: 15000
      });

      if (response.data && response.data.currentUser) {
        const user = response.data.currentUser;
        
        this.userProfile = {
          id: user.id,
          name: `${user.firstName} ${user.lastName}`.trim(),
          email: user.email,
          glookoCode: user.glookoCode,
          country: user.countryOfResidence,
          euResident: user.euResident,
          diabetesType: user.diabetesType,
          userType: user.userType,
          activated: user.activated,
          meterUnits: user.meterUnits,
          language: user.preference?.language || 'en',
          createdAt: user.createdAt,
          updatedAt: user.updatedAt
        };

        // Extract glucose preferences (convert from Glooko internal units)
        this.userProfile.glucoseTargets = {
          units: user.meterUnits, // 'mmoll' or 'mgdl'
          normalMin: user.preference?.normalGlucoseMin / 1000, // Convert to mmol/L
          beforeMealMax: user.preference?.beforeMealNormalGlucoseMax / 1000,
          afterMealMax: user.preference?.afterMealNormalGlucoseMax / 1000,
          mealTimes: {
            breakfast: user.preference?.breakfastBegin / 3600, // Convert seconds to hours
            lunch: user.preference?.lunchBegin / 3600,
            dinner: user.preference?.dinnerBegin / 3600,
            midnightSnack: user.preference?.midnightSnackBegin / 3600
          }
        };

        // Extract device connection status
        this.deviceStatus = {
          connectedDevices: [],
          hasData: false,
          lastSyncTimestamps: user.lastSyncTimestamps || {}
        };

        // Check device connections
        const deviceFlags = [
          { name: 'Eversense CGM', connected: user.eversenseConnected, type: 'cgm' },
          { name: 'iGlucose', connected: user.iglucoseConnected, type: 'cgm' },
          { name: 'Insulet Dash Cloud', connected: user.insuletDashCloudConnected, type: 'pump' },
          { name: 'Omnipod 5', connected: user.hasOmnipod5, type: 'pump' },
          { name: 'Abbott CSV', connected: user.hasAbbottCsv, type: 'cgm' },
          { name: 'Medtronic Closed Loop', connected: user.hasMedtronicClosedLoopData, type: 'pump' },
          { name: 'Control IQ', connected: user.hasControlIqData, type: 'pump' },
          { name: 'Closed Loop Device', connected: user.hasClosedLoopDevice, type: 'pump' }
        ];

        deviceFlags.forEach(device => {
          if (device.connected) {
            this.deviceStatus.connectedDevices.push({
              name: device.name,
              type: device.type,
              connected: true
            });
            this.deviceStatus.hasData = true;
          }
        });

        // Log profile summary
        this.log(`👤 User Profile: ${this.userProfile.name} (${this.userProfile.country})`);
        this.log(`📊 Glucose Units: ${this.userProfile.meterUnits === 'mmoll' ? 'mmol/L' : 'mg/dL'}`);
        this.log(`🎯 Glucose Targets: ${this.userProfile.glucoseTargets.normalMin}-${this.userProfile.glucoseTargets.afterMealMax} mmol/L`);
        
        if (this.deviceStatus.connectedDevices.length > 0) {
          this.log(`📱 Connected Devices: ${this.deviceStatus.connectedDevices.map(d => d.name).join(', ')}`);
        } else {
          this.log(`📱 No devices currently connected`);
        }

        // Check sync timestamps
        const syncTypes = Object.keys(this.deviceStatus.lastSyncTimestamps);
        const recentSyncs = syncTypes.filter(type => this.deviceStatus.lastSyncTimestamps[type]).length;
        if (recentSyncs > 0) {
          this.log(`🔄 Recent syncs: ${recentSyncs}/${syncTypes.length} device types`);
        }

      } else {
        throw new Error('Invalid response format from user profile API');
      }

    } catch (error) {
      this.log(`⚠️  Failed to fetch user profile: ${error.message}`);
      // Don't throw - profile is optional for CGM reading
    }
  }

  async fetchCGMReadings(options = {}) {
    const { 
      hoursBack = 24, 
      forceFullFetch = false,
      maxRetries = 3 
    } = options;
    
    let retryCount = 0;
    
    while (retryCount < maxRetries) {
      try {
        const session = await this.authenticate(retryCount > 0);
        
        // Determine fetch parameters
        const now = new Date();
        let guid, startTime, fetchType;
        
        if (forceFullFetch || !this.lastGuid || !this.lastReadingTime) {
          // Full fetch
          guid = '1e0c094e-1e54-4a4f-8e6a-f94484b53789'; // Dummy GUID for initial fetch
          startTime = new Date(now.getTime() - (hoursBack * 60 * 60 * 1000));
          fetchType = 'FULL';
          this.log(`📊 Performing FULL fetch (last ${hoursBack} hours)`);
        } else {
          // Incremental fetch
          guid = this.lastGuid;
          startTime = new Date(this.lastReadingTime);
          fetchType = 'INCREMENTAL';
          const hoursSinceLastReading = (now.getTime() - startTime.getTime()) / (1000 * 60 * 60);
          this.log(`📊 Performing INCREMENTAL fetch (${hoursSinceLastReading.toFixed(1)} hours since last reading)`);
        }
        
        // Calculate limit (5-minute intervals = 12 per hour)
        const hoursSinceStart = (now.getTime() - startTime.getTime()) / (1000 * 60 * 60);
        const limit = Math.min(2880, Math.ceil(hoursSinceStart * 12)); // Max 10 days
        
        // Use internal graph API (cookie-based authentication)
        const startDate = forceFullFetch ? 
          new Date(now.toISOString().split('T')[0] + 'T00:00:00.000Z').toISOString() : 
          startTime.toISOString();
        const endDate = forceFullFetch ? 
          new Date(now.toISOString().split('T')[0] + 'T23:59:59.999Z').toISOString() : 
          now.toISOString();
        
        this.log(`📅 Time range: ${startDate} to ${endDate}`);
        
        // Internal graph API - the only viable option with cookie authentication
        const graphApiUrl = `${this.config.apiUrl}/api/v3/graph/data` +
                           `?patient=${session.patientId}` +
                           `&startDate=${startDate}` +
                           `&endDate=${endDate}` +
                           `&series[]=cgmHigh&series[]=cgmNormal&series[]=cgmLow` +
                           `&locale=en&insulinTooltips=true&filterBgReadings=true&splitByDay=false`;
        
        this.log(`🌐 Fetching CGM data from internal API...`);
        this.log(`   URL: ${graphApiUrl}`);
        
        const response = await axios.get(graphApiUrl, {
          headers: {
            'Accept': 'application/json',
            'Cookie': session.cookieHeader,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': `${this.config.webUrl}/`,
            'Origin': this.config.webUrl,
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-site'
          },
          timeout: 30000
        });
        
        this.log(`✅ Internal graph API responded successfully`);
        
        // Parse graph API response
        const series = response.data.series || {};
        const allCgmReadings = [
          ...(series.cgmHigh || []),
          ...(series.cgmNormal || []),
          ...(series.cgmLow || [])
        ];
        
        // Convert graph data to readings format
        const readings = allCgmReadings.map(point => ({
          // The 'value' field from Glooko is already in a special format (y * 1801.43)
          // For Nightscout, we need mg/dL, so convert: mmol/L × 18.0143
          value: Math.round(point.y * 18.0143),
          timestampUTC: point.timestamp,
          timestamp: point.timestamp,
          y_mmol: point.y, // Actual glucose value in mmol/L
          x: point.x, // epoch timestamp in seconds
          mealTag: point.mealTag,
          calculated: point.calculated,
          glookoValue: point.value, // Glooko's internal value (y * 1801.43)
          // Generate a simple ID since graph data doesn't have GUIDs
          guid: `glooko_${point.x}_${point.y}`,
          trend: null, // Graph API doesn't provide trend data
          deviceName: 'glooko-cgm'
        }));
        
        this.log(`📊 Using graph API response format`);
        this.log(`   cgmHigh: ${series.cgmHigh?.length || 0} readings`);
        this.log(`   cgmNormal: ${series.cgmNormal?.length || 0} readings`);
        this.log(`   cgmLow: ${series.cgmLow?.length || 0} readings`);
        
        // Log the latest reading from each category for debugging
        if (series.cgmLow?.length > 0) {
          const latestLow = series.cgmLow[series.cgmLow.length - 1];
          this.log(`   ⚠️  Latest LOW: ${latestLow.y} mmol/L @ ${latestLow.timestamp}`);
        }
        if (allCgmReadings.length > 0) {
          // Sort by timestamp to find actual latest
          const sorted = [...allCgmReadings].sort((a, b) => 
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
          );
          const latest = sorted[0];
          this.log(`   📍 Actual latest: ${latest.y} mmol/L @ ${latest.timestamp}`);
        }
        
        // Log raw CGM values from Glooko before transformation
        console.log('\n📋 RAW GLOOKO CGM DATA:');
        console.log('========================');
        console.log(`API Used: GRAPH`);
        console.log(`Retrieved ${readings.length} raw readings from Glooko API`);
        if (readings.length > 0) {
          console.log('Sample raw reading structure:');
          console.log(JSON.stringify(readings[0], null, 2));
          if (readings.length > 1) {
            console.log(`\nAll ${readings.length} raw values:`, readings.map(r => ({
              value: r.value,
              timestamp: r.timestampUTC || r.timestamp,
              trend: r.trend || r.trendArrow || r.trendValue || 'N/A',
              guid: r.guid || r.id || r.recordId
            })));
          }
        }
        console.log('========================\n');
        
        // Update checkpoint with newest reading
        if (readings.length > 0) {
          // Sort by timestamp to ensure we get the newest
          readings.sort((a, b) => {
            const timeA = new Date(a.timestampUTC || a.timestamp).getTime();
            const timeB = new Date(b.timestampUTC || b.timestamp).getTime();
            return timeB - timeA; // Newest first
          });
          
          const newestReading = readings[0];
          this.lastGuid = newestReading.guid || newestReading.id || newestReading.recordId;
          this.lastReadingTime = newestReading.timestampUTC || newestReading.timestamp;
          
          this.log(`✅ Retrieved ${readings.length} readings`);
          this.log(`   Newest: ${new Date(this.lastReadingTime).toLocaleString()}`);
          this.log(`   Oldest: ${new Date(readings[readings.length - 1].timestampUTC || readings[readings.length - 1].timestamp).toLocaleString()}`);
        } else {
          this.log(`ℹ️  No new readings available`);
        }
        
        return readings;
        
      } catch (error) {
        retryCount++;
        
        if (error.response?.status === 401 || error.response?.status === 403) {
          this.log(`⚠️  Authentication error, retrying... (${retryCount}/${maxRetries})`);
          this.session = null;
          this.sessionExpiry = null;
        } else {
          this.log(`❌ API error (attempt ${retryCount}/${maxRetries}): ${error.message}`);
        }
        
        if (retryCount >= maxRetries) {
          throw error;
        }
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 5000 * retryCount));
      }
    }
  }

  transformToNightscout(glookoReadings) {
    this.log(`🔄 Converting ${glookoReadings.length} readings to Nightscout format...`);
    
    const entries = glookoReadings.map(reading => {
      // Glooko timestamps appear to be in UTC+2 (not pure UTC)
      // The timestamp field shows UTC but the actual time seems to be local
      const timestamp = new Date(reading.timestampUTC || reading.timestamp);
      
      // Subtract 1 hour to correct for the timezone offset issue
      // (Glooko seems to provide UTC+2 timestamps labeled as UTC)
      const correctedTimestamp = new Date(timestamp.getTime() - (2 * 60 * 60 * 1000));
      
      const entry = {
        type: 'sgv',
        sgv: Math.round(reading.value), // This is mg/dL for Nightscout compatibility
        sgv_mmol: reading.y_mmol, // Keep mmol/L value for display
        date: correctedTimestamp.getTime(), // Corrected timestamp
        dateString: correctedTimestamp.toISOString(),
        localTime: correctedTimestamp.toLocaleString('en-FI', { timeZone: 'Europe/Helsinki' }),
        direction: this.getTrendArrow(reading.trend || reading.trendArrow || reading.trendValue),
        device: reading.deviceName || 'glooko-cgm'
      };
      
      // Add optional fields if available
      if (reading.transmitterId) entry.transmitterId = reading.transmitterId;
      if (reading.noise !== undefined) entry.noise = reading.noise;
      if (reading.filtered !== undefined) entry.filtered = reading.filtered;
      if (reading.unfiltered !== undefined) entry.unfiltered = reading.unfiltered;
      if (reading.rssi !== undefined) entry.rssi = reading.rssi;
      if (reading.guid) entry.glookoGuid = reading.guid;
      
      return entry;
    }).filter(entry => {
      // Filter out invalid readings (check mmol/L values)
      return entry.sgv_mmol && entry.sgv_mmol > 0 && entry.sgv_mmol < 30;
    });
    
    // Sort by date (newest first)
    entries.sort((a, b) => b.date - a.date);
    
    this.log(`✅ Transformed ${entries.length} valid entries`);
    
    return entries;
  }

  getTrendArrow(trend) {
    // Map various trend formats to Nightscout direction arrows
    const trendMap = {
      // Text-based trends
      'RISING_QUICKLY': 'DoubleUp',
      'RISING': 'SingleUp',
      'RISING_SLIGHTLY': 'FortyFiveUp',
      'STEADY': 'Flat',
      'FALLING_SLIGHTLY': 'FortyFiveDown',
      'FALLING': 'SingleDown',
      'FALLING_QUICKLY': 'DoubleDown',
      
      // Numeric trends (Dexcom style)
      '1': 'DoubleUp',
      '2': 'SingleUp',
      '3': 'FortyFiveUp',
      '4': 'Flat',
      '5': 'FortyFiveDown',
      '6': 'SingleDown',
      '7': 'DoubleDown',
      
      // Special cases
      'NONE': 'NONE',
      'NOT_COMPUTABLE': 'NOT COMPUTABLE',
      'RATE_OUT_OF_RANGE': 'RateOutOfRange',
      '9': 'NOT COMPUTABLE',
      '0': 'NONE'
    };
    
    return trendMap[trend] || trendMap[String(trend)] || 'NONE';
  }

  saveCheckpoint() {
    const checkpoint = {
      lastGuid: this.lastGuid,
      lastReadingTime: this.lastReadingTime,
      patientId: this.patientId,
      savedAt: new Date().toISOString()
    };
    
    try {
      fs.writeFileSync(this.config.checkpointFile, JSON.stringify(checkpoint, null, 2));
      this.log(`💾 Checkpoint saved`);
      return checkpoint;
    } catch (error) {
      this.log(`⚠️  Failed to save checkpoint: ${error.message}`);
      return null;
    }
  }

  loadCheckpoint() {
    try {
      if (fs.existsSync(this.config.checkpointFile)) {
        const checkpoint = JSON.parse(fs.readFileSync(this.config.checkpointFile, 'utf8'));
        this.lastGuid = checkpoint.lastGuid;
        this.lastReadingTime = checkpoint.lastReadingTime;
        this.patientId = checkpoint.patientId;
        
        this.log(`♻️  Loaded checkpoint from ${new Date(this.lastReadingTime).toLocaleString()}`);
        
        return checkpoint;
      }
    } catch (error) {
      this.log(`⚠️  Failed to load checkpoint: ${error.message}`);
    }
    
    this.log('📋 No checkpoint found, will perform full fetch');
    return null;
  }

  async getLatestCGMData(options = {}) {
    const startTime = Date.now();
    
    try {
      // Load checkpoint for incremental fetching
      this.loadCheckpoint();
      
      // Fetch readings
      const readings = await this.fetchCGMReadings(options);
      
      // Transform to Nightscout format
      const nightscoutEntries = this.transformToNightscout(readings);
      
      // Save checkpoint for next run
      if (readings.length > 0) {
        this.saveCheckpoint();
      }
      
      // Calculate statistics
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
      
      const result = {
        success: true,
        entries: nightscoutEntries,
        count: nightscoutEntries.length,
        latestReading: nightscoutEntries[0],
        oldestReading: nightscoutEntries[nightscoutEntries.length - 1],
        executionTime: `${executionTime}s`,
        userProfile: this.userProfile,
        deviceStatus: this.deviceStatus,
        checkpoint: {
          lastGuid: this.lastGuid,
          lastReadingTime: this.lastReadingTime
        }
      };
      
      // Display summary
      console.log('\n📊 GLOOKO CGM DATA SUMMARY');
      console.log('===========================');
      
      // User profile summary
      if (this.userProfile) {
        console.log(`👤 User: ${this.userProfile.name} (${this.userProfile.country?.toUpperCase()})`);
        console.log(`📊 Units: ${this.userProfile.meterUnits === 'mmoll' ? 'mmol/L' : 'mg/dL'}`);
        console.log(`🎯 Targets: ${this.userProfile.glucoseTargets.normalMin.toFixed(1)}-${this.userProfile.glucoseTargets.afterMealMax.toFixed(1)} mmol/L`);
        
        if (this.deviceStatus?.connectedDevices.length > 0) {
          console.log(`📱 Connected: ${this.deviceStatus.connectedDevices.map(d => d.name).join(', ')}`);
        } else {
          console.log(`📱 Devices: None currently connected`);
        }
        console.log('');
      }
      
      if (result.count > 0) {
        console.log(`✅ Success: ${result.count} readings retrieved`);
        console.log(`⏱️  Execution time: ${result.executionTime}`);
        console.log(`📈 Latest: ${result.latestReading.sgv_mmol} mmol/L @ ${result.latestReading.localTime}`);
        console.log(`📉 Oldest: ${result.oldestReading.sgv_mmol} mmol/L @ ${result.oldestReading.localTime}`);
        console.log(`➡️  Trend: ${result.latestReading.direction}`);
        console.log(`\n🩸 All readings (mmol/L, Helsinki time):`);
        result.entries.slice(0, 10).forEach((entry, i) => {
          console.log(`   ${i + 1}. ${entry.sgv_mmol} mmol/L @ ${entry.localTime}`);
        });
        if (result.entries.length > 10) {
          console.log(`   ... and ${result.entries.length - 10} more`);
        }
      } else {
        console.log('ℹ️  No new readings available');
      }
      
      return result;
      
    } catch (error) {
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
      
      console.log(`\n❌ FETCH FAILED`);
      console.log(`   Error: ${error.message}`);
      console.log(`   Execution time: ${executionTime}s`);
      
      return {
        success: false,
        error: error.message,
        entries: [],
        executionTime: `${executionTime}s`
      };
    }
  }

  async exportToFile(filename = null) {
    const data = await this.getLatestCGMData();
    
    if (data.success && data.entries.length > 0) {
      const outputFile = filename || `cgm-readings-${new Date().toISOString().split('T')[0]}.json`;
      
      const exportData = {
        exportedAt: new Date().toISOString(),
        source: 'Glooko',
        patientId: this.patientId,
        userProfile: this.userProfile,
        deviceStatus: this.deviceStatus,
        count: data.count,
        entries: data.entries
      };
      
      fs.writeFileSync(outputFile, JSON.stringify(exportData, null, 2));
      console.log(`\n📄 Exported ${data.count} readings to ${outputFile}`);
      
      return outputFile;
    } else {
      console.log('\n⚠️  No data to export');
      return null;
    }
  }
}

// Command-line interface
async function main() {
  const args = process.argv.slice(2);
  
  // Check for help
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Glooko CGM Reader - Fetch CGM data from Glooko

Usage: node glooko-cgm-reader.js [options]

Options:
  --email EMAIL        Glooko account email (or set GLOOKO_EMAIL env var)
  --password PASSWORD  Glooko account password (or set GLOOKO_PASSWORD env var)
  --env ENV           Environment: eu, us, de (default: eu)
  --hours N           Hours of data to fetch (default: 24)
  --full              Force full fetch, ignore checkpoint
  --export [FILE]     Export data to JSON file
  --debug             Enable debug logging
  --help, -h          Show this help message

Environment Variables:
  GLOOKO_EMAIL        Glooko account email
  GLOOKO_PASSWORD     Glooko account password
  GLOOKO_ENV          Environment (eu/us/de)
  GLOOKO_TZ_OFFSET    Timezone offset in milliseconds

Examples:
  # Fetch latest data using environment variables
  node glooko-cgm-reader.js

  # Fetch with credentials
  node glooko-cgm-reader.js --email user@example.com --password mypass

  # Fetch last 48 hours and export
  node glooko-cgm-reader.js --hours 48 --export

  # Force full fetch with debug output
  node glooko-cgm-reader.js --full --debug
`);
    process.exit(0);
  }
  
  // Suppress dotenv console output
  if (!args.includes('--debug')) {
    process.env.DOTENV_CONFIG_QUIET = 'true';
  }
  
  // Parse command-line arguments
  const getArg = (name, defaultValue = null) => {
    const index = args.indexOf(name);
    return index !== -1 && args[index + 1] ? args[index + 1] : defaultValue;
  };
  
  const config = {
    email: getArg('--email') || process.env.GLOOKO_EMAIL,
    password: getArg('--password') || process.env.GLOOKO_PASSWORD,
    env: getArg('--env') || process.env.GLOOKO_ENV || 'eu',
    timezoneOffset: parseInt(process.env.GLOOKO_TZ_OFFSET || '0'),
    debug: args.includes('--debug')
  };
  
  // Validate credentials
  if (!config.email || !config.password) {
    console.error('❌ Error: Email and password are required');
    console.error('   Set via --email/--password flags or GLOOKO_EMAIL/GLOOKO_PASSWORD environment variables');
    console.error('   Run with --help for more information');
    process.exit(1);
  }
  
  // Show header
  console.log('\n🚀 GLOOKO CGM READER');
  console.log('===================');
  console.log(`Email: ${config.email}`);
  console.log(`Password: ${'*'.repeat(config.password.length)}`);
  console.log(`Environment: ${config.env}`);
  console.log('');
  
  try {
    const reader = new GlookoCGMReader(config);
    
    const options = {
      hoursBack: parseInt(getArg('--hours') || '24'),
      forceFullFetch: args.includes('--full')
    };
    
    if (args.includes('--export')) {
      const exportFile = typeof getArg('--export') === 'string' ? getArg('--export') : null;
      await reader.exportToFile(exportFile);
    } else {
      const result = await reader.getLatestCGMData(options);
      if (!result.success) {
        throw new Error(result.error);
      }
    }
    
    console.log('\n✅ Script completed successfully\n');
    process.exit(0);
    
  } catch (error) {
    console.error('\n❌ Script failed:', error.message);
    if (config.debug) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Export for use as module
module.exports = { GlookoCGMReader };

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}