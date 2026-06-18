export function cleanCLIOutput(output: string): string {
  let lines = output.split("\n");
  lines = lines.filter(line => {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();
    
    // Фильтруем предупреждения и служебные логи
    if (lower.startsWith("warning:") || lower.startsWith("warn:")) return false;
    if (trimmed.includes("ExperimentalWarning:") || trimmed.includes("DeprecationWarning:")) return false;
    if (trimmed.startsWith("[Codex]") || trimmed.startsWith("[info]") || trimmed.startsWith("[debug]")) return false;
    if (trimmed.startsWith(">")) return false;
    
    // Фильтруем промежуточные логи мыслей Antigravity CLI (agy/gemini)
    if (lower.startsWith("i will ") || 
        lower.startsWith("i am ") || 
        lower.startsWith("i have ") || 
        lower.startsWith("reading ") || 
        lower.startsWith("searching ") || 
        lower.startsWith("analyzing ") || 
        lower.startsWith("inspecting ")) return false;
        
    return true;
  });
  return lines.join("\n").trim();
}

export function stripAnsi(str: string): string {
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}
