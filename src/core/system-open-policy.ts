// Browser-safe: opening these types with their default association may execute code.
export function requiresSystemOpenConfirmation(value: string): boolean {
  return /\.(?:exe|com|bat|cmd|ps1|psm1|psd1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|scr|cpl|reg|lnk|url|application|appref-ms)$/i.test(value);
}
