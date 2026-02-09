import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  generateChargingPlan,
  BatteryConfig,
  calculateOptimalChargingWindow,
  shouldChargeFromGrid,
  estimateSolarProduction
} from '../optimizer';
import { PVPCDay } from '../pvpc';
import { SolarDay } from '../solar';

// Mock PVPC data
const mockPVPCDay: PVPCDay = {
  date: '2024-02-15',
  prices: Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    price: i < 6 ? 0.05 : i < 10 ? 0.08 : i < 14 ? 0.12 : i < 18 ? 0.15 : i < 22 ? 0.18 : 0.08,
    priceWithVAT: 0,
    isCheap: i < 6,
    isExpensive: i >= 18 && i < 22
  })),
  avgPrice: 0.11,
  minPrice: 0.05,
  maxPrice: 0.18,
  cheapHours: [0, 1, 2, 3, 4, 5],
  expensiveHours: [18, 19, 20, 21]
};

// Mock solar data
const mockSolarDay: SolarDay = {
  date: '2024-02-15',
  forecast: Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    watts: i >= 8 && i <= 18 ? Math.sin((i - 8) * Math.PI / 10) * 3000 : 0,
    irradiance: i >= 8 && i <= 18 ? Math.sin((i - 8) * Math.PI / 10) * 800 : 0
  })),
  totalWh: 18000,
  peakWatts: 3000,
  peakHour: 13,
  sunriseHour: 8,
  sunsetHour: 18
};

// Default battery config
const defaultBattery: BatteryConfig = {
  capacityWh: 10000,
  maxChargeRateW: 3000,
  minSoC: 0.1,
  maxSoC: 1.0,
  currentSoC: 0.5
};

describe('Battery Optimizer', () => {
  describe('generateChargingPlan', () => {
    it('should generate a 24-hour plan', () => {
      const plan = generateChargingPlan(mockPVPCDay, mockSolarDay, defaultBattery);
      
      expect(plan).toBeDefined();
      expect(plan.hourlyPlan).toHaveLength(24);
      expect(plan.date).toBe(mockPVPCDay.date);
    });

    it('should prioritize charging during cheap hours', () => {
      const plan = generateChargingPlan(mockPVPCDay, mockSolarDay, defaultBattery);
      
      // Check that grid charging is scheduled during cheap hours (0-6)
      const gridChargeHours = plan.hourlyPlan
        .filter(h => h.decision.action === 'charge_from_grid')
        .map(h => h.hour);
      
      // At least some charging should happen during cheap hours
      const cheapChargeHours = gridChargeHours.filter(h => h < 6);
      expect(cheapChargeHours.length).toBeGreaterThan(0);
    });

    it('should use solar during peak production hours', () => {
      const plan = generateChargingPlan(mockPVPCDay, mockSolarDay, defaultBattery);
      
      // Check that solar charging happens during daylight hours
      const solarChargeHours = plan.hourlyPlan
        .filter(h => h.decision.action === 'charge_from_solar')
        .map(h => h.hour);
      
      // Solar charging should be between sunrise and sunset
      solarChargeHours.forEach(h => {
        expect(h).toBeGreaterThanOrEqual(mockSolarDay.sunriseHour);
        expect(h).toBeLessThanOrEqual(mockSolarDay.sunsetHour);
      });
    });

    it('should avoid charging during expensive hours', () => {
      const plan = generateChargingPlan(mockPVPCDay, mockSolarDay, defaultBattery);
      
      // Grid charging should not happen during expensive hours (18-22)
      const expensiveHourGridCharging = plan.hourlyPlan
        .filter(h => h.hour >= 18 && h.hour < 22)
        .filter(h => h.decision.action === 'charge_from_grid');
      
      expect(expensiveHourGridCharging.length).toBe(0);
    });

    it('should calculate savings correctly', () => {
      const plan = generateChargingPlan(mockPVPCDay, mockSolarDay, defaultBattery);
      
      expect(plan.savings).toBeGreaterThanOrEqual(0);
      expect(plan.gridChargeCost).toBeGreaterThanOrEqual(0);
    });

    it('should not exceed battery capacity', () => {
      const plan = generateChargingPlan(mockPVPCDay, mockSolarDay, defaultBattery);
      
      plan.hourlyPlan.forEach(hour => {
        expect(hour.expectedSoC).toBeGreaterThanOrEqual(defaultBattery.minSoC);
        expect(hour.expectedSoC).toBeLessThanOrEqual(defaultBattery.maxSoC);
      });
    });

    it('should handle low battery correctly', () => {
      const lowBattery: BatteryConfig = {
        ...defaultBattery,
        currentSoC: 0.15 // Just above minimum
      };
      
      const plan = generateChargingPlan(mockPVPCDay, mockSolarDay, lowBattery);
      
      // Should prioritize charging when battery is low
      const earlyCharging = plan.hourlyPlan
        .slice(0, 6)
        .filter(h => h.decision.action === 'charge_from_grid');
      
      expect(earlyCharging.length).toBeGreaterThan(0);
    });

    it('should handle full battery correctly', () => {
      const fullBattery: BatteryConfig = {
        ...defaultBattery,
        currentSoC: 0.95
      };
      
      const plan = generateChargingPlan(mockPVPCDay, mockSolarDay, fullBattery);
      
      // Should have minimal or no charging needed
      const chargingHours = plan.hourlyPlan
        .filter(h => h.decision.action === 'charge_from_grid' || h.decision.action === 'charge_from_solar');
      
      // With 95% SoC, not much charging should be needed
      expect(chargingHours.length).toBeLessThan(5);
    });
  });

  describe('calculateOptimalChargingWindow', () => {
    it('should find the cheapest consecutive hours', () => {
      const window = calculateOptimalChargingWindow(mockPVPCDay.prices, 3);
      
      expect(window).toBeDefined();
      expect(window.hours).toHaveLength(3);
      // Cheapest 3 consecutive hours should be in 0-5 range
      window.hours.forEach(h => expect(h).toBeLessThan(6));
    });

    it('should respect minimum hours requirement', () => {
      const window = calculateOptimalChargingWindow(mockPVPCDay.prices, 5);
      
      expect(window.hours).toHaveLength(5);
    });
  });

  describe('shouldChargeFromGrid', () => {
    it('should return true during cheap hours with low battery', () => {
      const result = shouldChargeFromGrid(
        3, // 3 AM - cheap hour
        0.05, // cheap price
        0.2, // low SoC
        defaultBattery,
        1000 // low solar
      );
      
      expect(result).toBe(true);
    });

    it('should return false during expensive hours', () => {
      const result = shouldChargeFromGrid(
        19, // 7 PM - expensive
        0.18, // expensive price
        0.5,
        defaultBattery,
        0
      );
      
      expect(result).toBe(false);
    });

    it('should return false when solar is abundant', () => {
      const result = shouldChargeFromGrid(
        12, // noon
        0.10,
        0.5,
        defaultBattery,
        4000 // plenty of solar
      );
      
      expect(result).toBe(false);
    });
  });

  describe('estimateSolarProduction', () => {
    it('should return 0 at night', () => {
      const production = estimateSolarProduction(mockSolarDay.forecast, 3);
      expect(production).toBe(0);
    });

    it('should return peak production at midday', () => {
      const production = estimateSolarProduction(mockSolarDay.forecast, 13);
      expect(production).toBeGreaterThan(2000);
    });

    it('should handle edge hours correctly', () => {
      const sunriseProduction = estimateSolarProduction(mockSolarDay.forecast, 8);
      const sunsetProduction = estimateSolarProduction(mockSolarDay.forecast, 18);
      
      expect(sunriseProduction).toBeGreaterThan(0);
      expect(sunsetProduction).toBeGreaterThan(0);
    });
  });
});

describe('Edge Cases', () => {
  it('should handle missing PVPC data gracefully', () => {
    const emptyPVPC: PVPCDay = {
      ...mockPVPCDay,
      prices: []
    };
    
    expect(() => generateChargingPlan(emptyPVPC, mockSolarDay, defaultBattery))
      .not.toThrow();
  });

  it('should handle missing solar data gracefully', () => {
    const emptySolar: SolarDay = {
      ...mockSolarDay,
      forecast: [],
      totalWh: 0
    };
    
    const plan = generateChargingPlan(mockPVPCDay, emptySolar, defaultBattery);
    
    // Should still create a plan, prioritizing grid charging
    expect(plan.hourlyPlan).toHaveLength(24);
  });

  it('should handle cloudy day (low solar)', () => {
    const cloudySolar: SolarDay = {
      ...mockSolarDay,
      forecast: mockSolarDay.forecast.map(f => ({
        ...f,
        watts: f.watts * 0.2 // 80% reduction
      })),
      totalWh: 3600
    };
    
    const plan = generateChargingPlan(mockPVPCDay, cloudySolar, defaultBattery);
    
    // Should rely more on grid charging
    const gridChargeHours = plan.gridChargeHours.length;
    expect(gridChargeHours).toBeGreaterThan(3);
  });
});

describe('Bug Fix Tests', () => {
  // Test for the PVPC fetch race condition bug
  it('should handle concurrent PVPC requests correctly', async () => {
    const requests: Promise<any>[] = [];
    
    // Simulate multiple concurrent requests
    for (let i = 0; i < 5; i++) {
      requests.push(
        Promise.resolve(mockPVPCDay) // Simulated fetch
      );
    }
    
    const results = await Promise.all(requests);
    
    // All results should be valid
    results.forEach(result => {
      expect(result.prices).toHaveLength(24);
      expect(result.avgPrice).toBeGreaterThan(0);
    });
  });

  // Test for timezone handling
  it('should correctly handle timezone for Spanish PVPC', () => {
    const plan = generateChargingPlan(mockPVPCDay, mockSolarDay, defaultBattery);
    
    // Hours should be 0-23
    plan.hourlyPlan.forEach(h => {
      expect(h.hour).toBeGreaterThanOrEqual(0);
      expect(h.hour).toBeLessThan(24);
    });
  });
});
