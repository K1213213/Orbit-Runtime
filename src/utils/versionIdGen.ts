/**
 * 版本子集解析 + 唯一标识生成工具
 * 仅支持 major.minor.patch三段版本；不引入第三方semver库
 */

export type EditionStruct = {
  major: number;
  minor: number;
  patch: number;
};

/**
 * 解析版本字符串，格式非法返回null
 */
export function parseEdition(raw: string): EditionStruct | null {
  const matched = raw.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!matched) return null;
  return {
    major: Number(matched[1]),
    minor: Number(matched[2]),
    patch: Number(matched[3])
  };
}

/**
 * 判断 a版本 是否大于等于 b版本
 */
export function editionGte(a: EditionStruct, b: EditionStruct): boolean {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}

/**
 * 校验插件单元版本满足宿主最低版本要求
 */
export function checkHostEditionRequirement(pluginEdition: string, hostMinRequire: string): boolean {
  const verPlugin = parseEdition(pluginEdition);
  const verMinHost = parseEdition(hostMinRequire);
  if (!verPlugin || !verMinHost) return false;
  return editionGte(verPlugin, verMinHost);
}

/**
 * 生成链路/实例唯一标记ID
 */
export function makeUniqueMark(): string {
  const randFragment = Math.random().toString(36).slice(2, 12);
  return `${Date.now()}-${randFragment}`;
}
