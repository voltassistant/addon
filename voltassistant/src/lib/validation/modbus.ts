/**
 * Modbus Input Validation
 * Validates and sanitizes Modbus register values for Deye inverters
 */

export interface ModbusValidationResult {
  valid: boolean;
  value?: number;
  error?: string;
  warning?: string;
  clamped?: boolean; // Value was clamped to valid range
}

export interface RegisterDefinition {
  name: string;
  address: number;
  type: 'uint16' | 'int16' | 'uint32' | 'int32' | 'float32';
  unit?: string;
  min?: number;
  max?: number;
  scale?: number; // Multiply raw value by this
  readOnly?: boolean;
  description?: string;
}

/**
 * Deye inverter register definitions
 */
export const DEYE_REGISTERS: Record<string, RegisterDefinition> = {
  // Battery registers
  batterySOC: {
    name: 'Battery SOC',
    address: 588,
    type: 'uint16',
    unit: '%',
    min: 0,
    max: 100,
    readOnly: true,
    description: 'Battery state of charge',
  },
  batteryVoltage: {
    name: 'Battery Voltage',
    address: 587,
    type: 'uint16',
    unit: 'V',
    scale: 0.1,
    min: 0,
    max: 60,
    readOnly: true,
  },
  batteryCurrent: {
    name: 'Battery Current',
    address: 590,
    type: 'int16',
    unit: 'A',
    scale: 0.01,
    min: -100,
    max: 100,
    readOnly: true,
  },
  batteryPower: {
    name: 'Battery Power',
    address: 591,
    type: 'int16',
    unit: 'W',
    min: -10000,
    max: 10000,
    readOnly: true,
  },
  batteryTemperature: {
    name: 'Battery Temperature',
    address: 586,
    type: 'int16',
    unit: '°C',
    scale: 0.1,
    min: -40,
    max: 80,
    readOnly: true,
  },

  // Solar registers
  pv1Power: {
    name: 'PV1 Power',
    address: 672,
    type: 'uint16',
    unit: 'W',
    min: 0,
    max: 15000,
    readOnly: true,
  },
  pv2Power: {
    name: 'PV2 Power',
    address: 673,
    type: 'uint16',
    unit: 'W',
    min: 0,
    max: 15000,
    readOnly: true,
  },
  totalPVPower: {
    name: 'Total PV Power',
    address: 534,
    type: 'uint16',
    unit: 'W',
    min: 0,
    max: 30000,
    readOnly: true,
  },

  // Grid registers
  gridPower: {
    name: 'Grid Power',
    address: 625,
    type: 'int16',
    unit: 'W',
    min: -15000,
    max: 15000,
    readOnly: true,
    description: 'Positive = importing, Negative = exporting',
  },
  gridVoltage: {
    name: 'Grid Voltage',
    address: 598,
    type: 'uint16',
    unit: 'V',
    scale: 0.1,
    min: 0,
    max: 300,
    readOnly: true,
  },
  gridFrequency: {
    name: 'Grid Frequency',
    address: 609,
    type: 'uint16',
    unit: 'Hz',
    scale: 0.01,
    min: 45,
    max: 55,
    readOnly: true,
  },

  // Load registers
  loadPower: {
    name: 'Load Power',
    address: 653,
    type: 'uint16',
    unit: 'W',
    min: 0,
    max: 15000,
    readOnly: true,
  },

  // Control registers (writable)
  workMode: {
    name: 'Work Mode',
    address: 142,
    type: 'uint16',
    min: 0,
    max: 3,
    readOnly: false,
    description: '0=Selling First, 1=Zero Export, 2=Time of Use, 3=Self-Use',
  },
  chargingPower: {
    name: 'Charging Power Limit',
    address: 108,
    type: 'uint16',
    unit: 'W',
    min: 0,
    max: 10000,
    readOnly: false,
  },
  dischargingPower: {
    name: 'Discharging Power Limit',
    address: 109,
    type: 'uint16',
    unit: 'W',
    min: 0,
    max: 10000,
    readOnly: false,
  },
  minSOC: {
    name: 'Minimum SOC',
    address: 166,
    type: 'uint16',
    unit: '%',
    min: 10,
    max: 100,
    readOnly: false,
  },
  maxSOC: {
    name: 'Maximum SOC',
    address: 167,
    type: 'uint16',
    unit: '%',
    min: 0,
    max: 100,
    readOnly: false,
  },
  gridChargingEnabled: {
    name: 'Grid Charging Enabled',
    address: 130,
    type: 'uint16',
    min: 0,
    max: 1,
    readOnly: false,
    description: '0=Disabled, 1=Enabled',
  },
};

/**
 * Validate raw Modbus register value
 */
export function validateRegisterValue(
  register: RegisterDefinition,
  rawValue: unknown
): ModbusValidationResult {
  // Check if value exists
  if (rawValue === null || rawValue === undefined) {
    return { valid: false, error: 'Value is null or undefined' };
  }

  // Convert to number
  const numValue = typeof rawValue === 'number' ? rawValue : Number(rawValue);

  if (isNaN(numValue)) {
    return { valid: false, error: 'Value is not a valid number' };
  }

  // Check for infinity
  if (!isFinite(numValue)) {
    return { valid: false, error: 'Value is infinite' };
  }

  // Apply scale factor
  const scaledValue = register.scale ? numValue * register.scale : numValue;

  // Check data type bounds
  let typeBounds = getTypeBounds(register.type);

  // Check against type bounds first
  if (numValue < typeBounds.min || numValue > typeBounds.max) {
    return {
      valid: false,
      error: `Value ${numValue} exceeds ${register.type} bounds (${typeBounds.min} to ${typeBounds.max})`,
    };
  }

  // Check against register-specific bounds
  let finalValue = scaledValue;
  let clamped = false;
  let warning: string | undefined;

  if (register.min !== undefined && scaledValue < register.min) {
    if (register.readOnly) {
      // For read-only, warn but accept
      warning = `Value ${scaledValue} below minimum ${register.min}${register.unit || ''} for ${register.name}`;
    } else {
      // For writable, clamp
      finalValue = register.min;
      clamped = true;
      warning = `Value clamped from ${scaledValue} to minimum ${register.min}`;
    }
  }

  if (register.max !== undefined && scaledValue > register.max) {
    if (register.readOnly) {
      warning = `Value ${scaledValue} exceeds maximum ${register.max}${register.unit || ''} for ${register.name}`;
    } else {
      finalValue = register.max;
      clamped = true;
      warning = `Value clamped from ${scaledValue} to maximum ${register.max}`;
    }
  }

  return {
    valid: true,
    value: finalValue,
    warning,
    clamped,
  };
}

/**
 * Get min/max bounds for Modbus data types
 */
function getTypeBounds(type: RegisterDefinition['type']): { min: number; max: number } {
  switch (type) {
    case 'uint16':
      return { min: 0, max: 65535 };
    case 'int16':
      return { min: -32768, max: 32767 };
    case 'uint32':
      return { min: 0, max: 4294967295 };
    case 'int32':
      return { min: -2147483648, max: 2147483647 };
    case 'float32':
      return { min: -3.4e38, max: 3.4e38 };
    default:
      return { min: 0, max: 65535 };
  }
}

/**
 * Validate a complete inverter state object
 */
export interface InverterState {
  batterySOC?: number;
  batteryVoltage?: number;
  batteryCurrent?: number;
  batteryPower?: number;
  batteryTemperature?: number;
  pv1Power?: number;
  pv2Power?: number;
  totalPVPower?: number;
  gridPower?: number;
  gridVoltage?: number;
  gridFrequency?: number;
  loadPower?: number;
  [key: string]: number | undefined;
}

export interface StateValidationResult {
  valid: boolean;
  state: InverterState;
  errors: string[];
  warnings: string[];
  invalidFields: string[];
}

export function validateInverterState(
  rawState: Record<string, unknown>
): StateValidationResult {
  const result: StateValidationResult = {
    valid: true,
    state: {},
    errors: [],
    warnings: [],
    invalidFields: [],
  };

  for (const [key, register] of Object.entries(DEYE_REGISTERS)) {
    if (!(key in rawState)) continue;

    const validation = validateRegisterValue(register, rawState[key]);

    if (!validation.valid) {
      result.errors.push(`${register.name}: ${validation.error}`);
      result.invalidFields.push(key);
      result.valid = false;
    } else {
      result.state[key] = validation.value;
      if (validation.warning) {
        result.warnings.push(`${register.name}: ${validation.warning}`);
      }
    }
  }

  // Cross-field validation
  const crossValidation = validateCrossFields(result.state);
  result.errors.push(...crossValidation.errors);
  result.warnings.push(...crossValidation.warnings);
  if (crossValidation.errors.length > 0) {
    result.valid = false;
  }

  return result;
}

/**
 * Cross-field validation (sanity checks)
 */
function validateCrossFields(state: InverterState): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // SOC should not change drastically in short time
  // (This would need historical data, so just basic checks here)

  // Battery voltage should correlate with SOC
  if (state.batteryVoltage !== undefined && state.batterySOC !== undefined) {
    // Typical LiFePO4: 48V system = 51.2V full, 44V empty
    const expectedMinVoltage = 44 + (state.batterySOC / 100) * 7;
    if (state.batteryVoltage < expectedMinVoltage - 5) {
      warnings.push('Battery voltage unusually low for reported SOC');
    }
  }

  // Power balance check: grid + pv ≈ load + battery
  if (
    state.gridPower !== undefined &&
    state.totalPVPower !== undefined &&
    state.loadPower !== undefined &&
    state.batteryPower !== undefined
  ) {
    const input = (state.gridPower > 0 ? state.gridPower : 0) + state.totalPVPower;
    const output = state.loadPower + (state.batteryPower > 0 ? state.batteryPower : 0);
    const imbalance = Math.abs(input - output);
    
    // Allow 10% or 100W imbalance
    const threshold = Math.max(100, (input + output) * 0.1);
    if (imbalance > threshold) {
      warnings.push(`Power imbalance detected: input=${input}W, output=${output}W, diff=${imbalance}W`);
    }
  }

  // Temperature sanity check
  if (state.batteryTemperature !== undefined) {
    if (state.batteryTemperature > 55) {
      errors.push('Battery temperature critically high (>55°C)');
    } else if (state.batteryTemperature > 45) {
      warnings.push('Battery temperature high (>45°C)');
    } else if (state.batteryTemperature < 0) {
      warnings.push('Battery temperature below freezing');
    }
  }

  // Grid frequency check
  if (state.gridFrequency !== undefined) {
    if (state.gridFrequency < 49 || state.gridFrequency > 51) {
      warnings.push(`Unusual grid frequency: ${state.gridFrequency}Hz`);
    }
  }

  return { errors, warnings };
}

/**
 * Validate a write command before sending to inverter
 */
export interface WriteCommand {
  register: string;
  value: number;
}

export function validateWriteCommand(command: WriteCommand): ModbusValidationResult {
  const register = DEYE_REGISTERS[command.register];

  if (!register) {
    return { valid: false, error: `Unknown register: ${command.register}` };
  }

  if (register.readOnly) {
    return { valid: false, error: `Register ${register.name} is read-only` };
  }

  return validateRegisterValue(register, command.value);
}

/**
 * Batch validate multiple write commands
 */
export function validateWriteCommands(
  commands: WriteCommand[]
): { valid: boolean; results: Map<string, ModbusValidationResult> } {
  const results = new Map<string, ModbusValidationResult>();
  let allValid = true;

  for (const cmd of commands) {
    const result = validateWriteCommand(cmd);
    results.set(cmd.register, result);
    if (!result.valid) {
      allValid = false;
    }
  }

  return { valid: allValid, results };
}
