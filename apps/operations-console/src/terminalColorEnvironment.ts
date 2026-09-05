// +-------------------------------------------------------------------------
//
//   地理智能平台 - 终端无色环境准备
//
//   文件:       terminalColorEnvironment.ts
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

/**
 * Ink 的底层着色库会在首次导入时读取 FORCE_COLOR。入口必须先调用本函数，
 * 才能让 NO_COLOR 与 dumb 终端覆盖冲突的强制着色设置。
 */
export function prepareTerminalColorEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (
    environment.NO_COLOR !== undefined
    || environment.TERM?.trim().toLowerCase() === 'dumb'
  ) {
    environment.FORCE_COLOR = '0'
  }
}
