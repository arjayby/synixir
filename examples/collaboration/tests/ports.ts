function port(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

export const frontendPort = port("SYNIXIR_TEST_FRONTEND_PORT", 5174);
export const backendPort = port("SYNIXIR_TEST_BACKEND_PORT", 4010);
export const frontendURL = `http://127.0.0.1:${frontendPort}`;
export const backendURL = `http://127.0.0.1:${backendPort}`;
