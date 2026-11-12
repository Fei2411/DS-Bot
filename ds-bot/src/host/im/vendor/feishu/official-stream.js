import { readFile } from "node:fs/promises";
import dns from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { AsyncLocalStorage } from "node:async_hooks";
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/core/auth-errors.ts
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* auth-errors.ts — 统一错误类型定义。
*
* 所有与认证/授权/scope 相关的错误类型集中在此文件，
* 解除 tool-client ↔ app-scope-checker 循环依赖。
*
* 其他模块应直接 import 此文件，或通过 tool-client / uat-client 的 re-export 使用。
*/
/** 飞书 OAPI 错误码常量，替代各处硬编码的 magic number。 */
const LARK_ERROR$1 = {
	/** 应用 scope 不足（租户维度） */
	APP_SCOPE_MISSING: 99991672,
	/** 用户 token scope 不足 */
	USER_SCOPE_INSUFFICIENT: 99991679,
	/** access_token 无效 */
	TOKEN_INVALID: 99991668,
	/** access_token 已过期 */
	TOKEN_EXPIRED: 99991677,
	/** refresh_token 本身无效（格式非法或来自 v1 API） */
	REFRESH_TOKEN_INVALID: 20026,
	/** refresh_token 已过期（超过 365 天） */
	REFRESH_TOKEN_EXPIRED: 20037,
	/** refresh_token 已被吊销 */
	REFRESH_TOKEN_REVOKED: 20064,
	/** refresh_token 已被使用（单次消费，rotation 场景） */
	REFRESH_TOKEN_ALREADY_USED: 20073,
	/** refresh token 端点服务端内部错误，可重试 */
	REFRESH_SERVER_ERROR: 20050,
	/** 消息已被撤回 */
	MESSAGE_RECALLED: 230011,
	/** 消息已被删除 */
	MESSAGE_DELETED: 231003
};
new Set([LARK_ERROR$1.REFRESH_SERVER_ERROR]);
/** 消息终止错误码集合（撤回/删除），遇到后应停止对该消息的后续操作。 */
const MESSAGE_TERMINAL_CODES$1 = new Set([LARK_ERROR$1.MESSAGE_RECALLED, LARK_ERROR$1.MESSAGE_DELETED]);
new Set([LARK_ERROR$1.TOKEN_INVALID, LARK_ERROR$1.TOKEN_EXPIRED]);
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/core/api-error.ts
function coerceCode(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
}
/**
* 从 Lark SDK 抛错对象中提取飞书 API code。
*
* 支持三种常见结构：
* - `{ code }` — SDK 直接挂载
* - `{ data: { code } }` — 响应体嵌套
* - `{ response: { data: { code } } }` — Axios 风格
*/
function extractLarkApiCode(err) {
	if (!err || typeof err !== "object") return void 0;
	const e = err;
	return coerceCode(e.code) ?? coerceCode(e.data?.code) ?? coerceCode(e.response?.data?.code);
}
/**
* Resolve the default agent id from an OpenClaw-shaped config subset
* (`agents.list[].default`). Used only by the CardKit footer-metrics lookup;
* an absent/default-less config falls back to `main`, mirroring upstream.
* @param cfg - the config object (structural subset).
* @returns the default agent id.
*/
function resolveDefaultAgentId(cfg) {
	const agents = cfg.agents;
	if (agents !== null && typeof agents === "object") {
		const list = agents.list;
		if (Array.isArray(list)) for (const entry of list) {
			if (entry === null || typeof entry !== "object") continue;
			const candidate = entry;
			if (candidate.default !== true) continue;
			if (typeof candidate.id === "string" && candidate.id.trim() !== "") return candidate.id.trim();
		}
		const defaults = agents.defaults;
		if (defaults !== null && typeof defaults === "object") {
			const id = defaults.agentId;
			if (typeof id === "string" && id.trim() !== "") return id.trim();
		}
	}
	return "main";
}
//#endregion
//#region logger.ts
let provider;
function setLoggerProvider(value) {
	provider = value;
}
function larkLogger$1(subsystem) {
	const fallback = {
		debug: (...args) => console.debug(`[feishu/${subsystem}]`, ...args),
		info: (...args) => console.log(`[feishu/${subsystem}]`, ...args),
		warn: (...args) => console.warn(`[feishu/${subsystem}]`, ...args),
		error: (...args) => console.error(`[feishu/${subsystem}]`, ...args)
	};
	return {
		subsystem,
		debug: (message, meta) => (provider?.logging?.getChildLogger?.({ subsystem }) ?? provider?.logger ?? fallback).debug?.(message, meta),
		info: (message, meta) => (provider?.logging?.getChildLogger?.({ subsystem }) ?? provider?.logger ?? fallback).info?.(message, meta),
		warn: (message, meta) => (provider?.logging?.getChildLogger?.({ subsystem }) ?? provider?.logger ?? fallback).warn?.(message, meta),
		error: (message, meta) => (provider?.logging?.getChildLogger?.({ subsystem }) ?? provider?.logger ?? fallback).error?.(message, meta),
		child: (name) => larkLogger$1(`${subsystem}/${name}`)
	};
}
//#endregion
//#region lark-client.ts
const clients = /* @__PURE__ */ new Map();
let runtime$1 = null;
function getResolvedConfig(cfg, accountId) {
	const root = cfg?.channels?.feishu ?? {};
	const base = { ...root };
	delete base.accounts;
	const id = String(accountId ?? "default").trim().toLowerCase() || "default";
	const override = root.accounts?.[id] ?? {};
	const merged = {
		...base,
		...override
	};
	for (const [key, value] of Object.entries(override)) if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) merged[key] = {
		...base[key],
		...value
	};
	return merged;
}
var LarkClient = class LarkClient {
	static cache = clients;
	_sdk;
	constructor(account) {
		this.account = account;
	}
	static fromCfg(cfg, accountId) {
		const id = String(accountId ?? "default").trim().toLowerCase() || "default";
		const config = getResolvedConfig(cfg, id);
		const account = {
			accountId: id,
			appId: config.appId,
			appSecret: config.appSecret,
			brand: config.domain ?? "feishu",
			config,
			configured: Boolean(config.appId && config.appSecret),
			enabled: config.enabled !== false
		};
		let client = clients.get(id);
		if (!client || client.account.appId !== account.appId || client.account.appSecret !== account.appSecret) {
			client = new LarkClient(account);
			clients.set(id, client);
		}
		return client;
	}
	static fromAccount(account) {
		return LarkClient.fromCfg({ channels: { feishu: {
			...account.config,
			appId: account.appId,
			appSecret: account.appSecret,
			domain: account.brand
		} } }, account.accountId);
	}
	static setRuntime(value) {
		runtime$1 = value;
	}
	static getRuntime() {
		return runtime$1;
	}
	get sdk() {
		return this._sdk;
	}
	dispose() {}
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/core/shutdown-hooks.ts
/**
* Process-level graceful shutdown hook registry.
*
* Provides a singleton Map of async cleanup callbacks, drained
* during graceful shutdown by the channel monitor.
*/
const hooks = /* @__PURE__ */ new Map();
/**
* Register a cleanup callback to run during graceful shutdown.
*
* @param key - Unique identifier for this hook (duplicate keys overwrite).
* @param cleanup - Async function to execute on shutdown.
* @returns An unregister function — call it when the resource is
*          released normally (e.g. card streaming completes).
*/
function registerShutdownHook(key, cleanup) {
	hooks.set(key, cleanup);
	return () => {
		hooks.delete(key);
	};
}
//#endregion
//#region send.ts
function targetType(id) {
	if (id.startsWith("oc_")) return "chat_id";
	if (id.startsWith("ou_")) return "open_id";
	return "user_id";
}
async function sendCardFeishu(params) {
	const client = LarkClient.fromCfg(params.cfg, params.accountId).sdk;
	const data = {
		content: JSON.stringify(params.card),
		msg_type: "interactive"
	};
	const response = params.replyToMessageId ? await client.im.message.reply({
		path: { message_id: params.replyToMessageId },
		data: {
			...data,
			reply_in_thread: params.replyInThread === true
		}
	}) : await client.im.message.create({
		params: {
			receive_id_type: targetType(params.to),
			...params.uuid ? { uuid: params.uuid } : {}
		},
		data: {
			...data,
			receive_id: params.to
		}
	});
	return {
		messageId: response?.data?.message_id ?? "",
		chatId: response?.data?.chat_id ?? ""
	};
}
async function updateCardFeishu(params) {
	await LarkClient.fromCfg(params.cfg, params.accountId).sdk.im.message.patch({
		path: { message_id: params.messageId },
		data: { content: JSON.stringify(params.card) }
	});
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/card/markdown-style.ts
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Markdown 样式优化工具
*/
/**
* 优化 Markdown 样式：
* - 标题降级：H1 → H4，H2~H6 → H5
* - 表格前后增加段落间距
* - 有序列表：序号后确保只有一个空格
* - 无序列表："- " 格式规范化（跳过分隔线 ---）
* - 表格：单元格前后补空格，分隔符行规范化，表格前后加空行
* - 代码块内容不受影响
*/
function optimizeMarkdownStyle(text, cardVersion = 2) {
	try {
		let r = _optimizeMarkdownStyle(text, cardVersion);
		r = stripInvalidImageKeys(r);
		return r;
	} catch {
		return text;
	}
}
function _optimizeMarkdownStyle(text, cardVersion = 2) {
	const MARK = "___CB_";
	const codeBlocks = [];
	let r = text.replace(/(^|\n)(`{3,})([^\n]*)\n[\s\S]*?\n\2(?=\n|$)/g, (m, prefix = "") => {
		const block = m.slice(String(prefix).length);
		return `${prefix}${MARK}${codeBlocks.push(block) - 1}___`;
	});
	if (/^#{1,3} /m.test(text)) {
		r = r.replace(/^#{2,6} (.+)$/gm, "##### $1");
		r = r.replace(/^# (.+)$/gm, "#### $1");
	}
	if (cardVersion >= 2) {
		r = r.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, "$1\n<br>\n$2");
		r = r.replace(/^([^|\n].*)\n(\|.+\|)/gm, "$1\n\n$2");
		r = r.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, "\n\n<br>\n\n$1");
		r = r.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, (m, _table, offset) => {
			const after = r.slice(offset + m.length).replace(/^\n+/, "");
			if (!after || /^(---|#{4,5} |\*\*)/.test(after)) return m;
			return m + "\n<br>\n";
		});
		r = r.replace(/^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm, "$1\n$2\n$3");
		r = r.replace(/^(\*\*.+)\n\n(<br>)\n\n(\|)/gm, "$1\n$2\n\n$3");
		r = r.replace(/(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm, "$1$2$3");
		codeBlocks.forEach((block, i) => {
			r = r.replace(`${MARK}${i}___`, `\n<br>\n${block}\n<br>\n`);
		});
	} else codeBlocks.forEach((block, i) => {
		r = r.replace(`${MARK}${i}___`, block);
	});
	r = r.replace(/\n{3,}/g, "\n\n");
	return r;
}
/** Matches complete markdown image syntax: `![alt](value)` */
const IMAGE_RE$1 = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
/**
* Strip `![alt](value)` where value is not a valid Feishu image key
* (`img_xxx`). Prevents CardKit error 200570.
*
* HTTP URLs are stripped as well — ImageResolver should have already
* replaced them with `img_xxx` keys before this point. This serves
* as a safety net for any unresolved URLs.
*/
function stripInvalidImageKeys(text) {
	if (!text.includes("![")) return text;
	return text.replace(IMAGE_RE$1, (fullMatch, _alt, value) => {
		if (value.startsWith("img_")) return fullMatch;
		return "";
	});
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/card/reasoning-utils.ts
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Shared utilities for the reasoning display subsystem.
*/
function normalizeToolName(name) {
	return name?.trim().toLowerCase() ?? "";
}
function truncateText(value, maxLength) {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 3)}...`;
}
const INLINE_ASSIGNMENT_RE = /(^|[\s"'`])([A-Za-z_][A-Za-z0-9_]*)(=(?:"[^"]*"|'[^']*'|[^\s"'`]+))/g;
const AUTH_HEADER_SECRET_RE = /(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)([^'"\s]+)/gi;
const QUOTED_HEADER_ARG_RE = /((?:^|[\s"'`])(?:-H|--header)\s+)(['"])([A-Za-z0-9_-]+)(\s*:\s*)([^'"]*)(\2)/gi;
const UNQUOTED_HEADER_ARG_RE = /((?:^|[\s"'`])(?:-H|--header)\s+)([A-Za-z0-9_-]+)(\s*:\s*)([^\s"'`]+)/gi;
const SECRET_FLAG_RE = /((?:^|[\s"'`]))(--?[A-Za-z0-9][A-Za-z0-9-]*)(=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s"'`]+))/g;
const SENSITIVE_NAME_RE = /token|secret|password|api[_-]?key|authorization|cookie|credential|bearer|session[_-]?id|client[_-]?secret|access[_-]?key/i;
function redactInlineSecrets(value) {
	return value.replace(INLINE_ASSIGNMENT_RE, (match, prefix, key) => isSensitiveName(key) ? `${prefix}${key}=[redacted]` : match).replace(AUTH_HEADER_SECRET_RE, "$1[redacted]").replace(QUOTED_HEADER_ARG_RE, (match, prefix, quote, name, separator) => shouldRedactHeaderValue(name) ? `${prefix}${quote}${name}${separator}[redacted]${quote}` : match).replace(UNQUOTED_HEADER_ARG_RE, (match, prefix, name, separator) => shouldRedactHeaderValue(name) ? `${prefix}${name}${separator}[redacted]` : match).replace(SECRET_FLAG_RE, (match, prefix, flag, separator, doubleQuoted, singleQuoted, bare) => {
		if (!isSensitiveName(flag.replace(/^-+/, ""))) return match;
		return `${prefix}${flag}${separator}${doubleQuoted !== void 0 ? "\"[redacted]\"" : singleQuoted !== void 0 ? "'[redacted]'" : bare !== void 0 ? "[redacted]" : "[redacted]"}`;
	});
}
function isSensitiveName(value) {
	return SENSITIVE_NAME_RE.test(value);
}
function shouldRedactHeaderValue(name) {
	return !/^authorization$/i.test(name) && isSensitiveName(name);
}
const DEFAULT_SUMMARY_PREFERENCE = [
	"matched",
	"code",
	"quoted",
	"url",
	"line"
];
const TOOL_DESCRIPTORS = [
	{
		aliases: ["skill"],
		iconToken: "app-default_outlined",
		title: "Load skill",
		sanitizer: "skill",
		paramKeys: ["skill", "name"],
		summaryPatterns: [/^(?:load|use)\s+skill\s+(.+)$/i]
	},
	{
		aliases: ["read", "open"],
		iconToken: "file-link-text_outlined",
		title: "Read",
		sanitizer: "path",
		paramKeys: [
			"file_path",
			"path",
			"file"
		],
		summaryPatterns: [/^(?:read|open)\s+(?:file\s+)?(.+)$/i],
		summaryPreference: [
			"code",
			"quoted",
			"matched",
			"line"
		]
	},
	{
		aliases: ["write", "edit"],
		iconToken: "edit_outlined",
		title: "Edit",
		sanitizer: "path",
		paramKeys: [
			"file_path",
			"path",
			"file"
		],
		summaryPatterns: [/^(?:edit|write)\s+(?:file\s+)?(.+)$/i],
		summaryPreference: [
			"code",
			"quoted",
			"matched",
			"line"
		]
	},
	{
		aliases: [
			"web_search",
			"web-search",
			"search"
		],
		iconToken: "search_outlined",
		title: "Search web",
		sanitizer: "search",
		paramKeys: ["query", "q"],
		summaryPatterns: [/^(?:search\s+(?:web\s+)?(?:for|about)|query)\s+(.+)$/i],
		summaryPreference: [
			"quoted",
			"matched",
			"line"
		]
	},
	{
		aliases: [
			"web_fetch",
			"web-fetch",
			"fetch"
		],
		iconToken: "language_outlined",
		title: "Fetch web page",
		sanitizer: "url",
		paramKeys: ["url"],
		summaryPatterns: [/^(?:fetch|open)\s+(?:web\s+page\s+)?(?:from\s+)?(.+)$/i],
		summaryPreference: [
			"url",
			"matched",
			"quoted",
			"line"
		]
	},
	{
		aliases: ["grep"],
		iconToken: "doc-search_outlined",
		title: "Search text",
		sanitizer: "generic",
		detailFromParams: (params) => buildPatternDetail(params, { includeTarget: true }),
		summaryPatterns: [/^(?:search\s+text(?:\s+by\s+pattern)?|grep)\s+(.+)$/i]
	},
	{
		aliases: ["glob"],
		iconToken: "folder_outlined",
		title: "Search files",
		sanitizer: "generic",
		paramKeys: ["pattern"],
		summaryPatterns: [/^(?:search\s+files(?:\s+by\s+pattern)?|glob)\s+(.+)$/i]
	},
	{
		aliases: [
			"exec",
			"bash",
			"command",
			"run"
		],
		iconToken: "setting_outlined",
		title: "Run command",
		sanitizer: "command",
		paramKeys: [
			"description",
			"command",
			"script"
		],
		summaryPatterns: [/^(?:run|execute)\s+(?:command|script)?\s*(.+)$/i],
		summaryPreference: [
			"code",
			"quoted",
			"matched",
			"line"
		]
	},
	{
		aliases: [
			"browser",
			"playwright",
			"navigate"
		],
		iconToken: "browser-mac_outlined",
		title: "Browser",
		sanitizer: "url",
		paramKeys: ["url"],
		summaryPatterns: [/^(?:open|browse|visit|navigate\s+to)\s+(.+)$/i],
		summaryPreference: [
			"url",
			"quoted",
			"matched",
			"line"
		]
	},
	{
		aliases: [
			"agent",
			"task",
			"spawn"
		],
		iconToken: "robot_outlined",
		title: "Run sub-agent",
		sanitizer: "generic",
		paramKeys: [
			"task",
			"description",
			"prompt"
		],
		summaryPatterns: [/^(?:run\s+sub-?agent|spawn\s+agent)\s+(.+)$/i]
	},
	{
		aliases: [
			"check",
			"determine",
			"verify"
		],
		iconToken: "list-check_outlined",
		title: "Check",
		sanitizer: "generic",
		paramKeys: [
			"target",
			"subject",
			"description"
		]
	},
	{
		aliases: [
			"summarize",
			"analyze",
			"prepare"
		],
		iconToken: "report_outlined",
		title: "Analyze",
		sanitizer: "generic",
		paramKeys: [
			"target",
			"subject",
			"description"
		]
	}
];
function normalizeToolUseDisplay(params) {
	const traceSteps = params.traceSteps ?? [];
	const showFullPaths = params.showFullPaths === true;
	const showResultDetails = params.showResultDetails === true;
	const steps = traceSteps.map(toTraceSource).map((source) => formatToolStep(source, {
		showFullPaths,
		showResultDetails
	})).filter((step) => !!step);
	return {
		content: steps.map((step) => step.detail ? `- ${step.title}: ${step.detail}` : `- ${step.title}`).join("\n"),
		stepCount: steps.length,
		steps
	};
}
function buildToolUseTitleSuffix(params) {
	const { stepCount } = params;
	return {
		zh: `查看 ${stepCount} 个步骤`,
		en: `Show ${stepCount} step${stepCount === 1 ? "" : "s"}`
	};
}
function toTraceSource(step) {
	return {
		toolName: step.toolName,
		params: step.params,
		result: step.result,
		error: step.error,
		durationMs: step.durationMs,
		status: step.status
	};
}
function formatToolStep(source, options) {
	const descriptor = resolveToolDescriptor(source.toolName);
	const rawDetail = (descriptor ? extractDetailFromParams(source.params, descriptor) : void 0) ?? (descriptor ? extractDetailFromSummary(source.summaryText, descriptor) : cleanupLine(source.summaryText ?? "")) ?? void 0;
	const detail = rawDetail ? sanitizeToolDetail(descriptor?.sanitizer ?? "generic", rawDetail, options) : void 0;
	const title = buildToolTitle(source, descriptor, rawDetail);
	const status = resolveStepStatus(source);
	const errorBlock = source.error ? buildErrorBlock(source.error, descriptor) : void 0;
	const resultBlock = !errorBlock && options.showResultDetails ? buildResultBlock(source, descriptor) : void 0;
	return {
		title,
		detail,
		iconToken: descriptor?.iconToken ?? "setting-inter_outlined",
		status,
		resultBlock,
		errorBlock
	};
}
function buildToolTitle(source, descriptor, rawDetail) {
	const baseTitle = descriptor?.title === "Read" && rawDetail && isSkillPathValue(rawDetail) ? "Skill Read" : descriptor?.title ?? humanizeToolName(source.toolName ?? "tool");
	const durationLabel = source.durationMs != null ? formatDurationLabel(source.durationMs) : void 0;
	return durationLabel ? `${baseTitle} (${durationLabel})` : baseTitle;
}
function resolveToolDescriptor(toolName) {
	const normalizedName = normalizeToolName(toolName);
	return TOOL_DESCRIPTORS.find((descriptor) => descriptor.aliases.some((alias) => normalizedName === alias || normalizedName.startsWith(`${alias}_`) || normalizedName.startsWith(`${alias}-`)));
}
function extractDetailFromParams(params, descriptor) {
	if (!params) return void 0;
	if (descriptor.detailFromParams) return descriptor.detailFromParams(params);
	for (const key of descriptor.paramKeys ?? []) {
		const value = params[key];
		const text = extractScalarText(value);
		if (text) return text;
	}
}
function extractDetailFromSummary(summaryText, descriptor) {
	if (!summaryText) return void 0;
	const lines = summaryText.replace(/\r\n/g, "\n").split("\n").map((line) => cleanupLine(stripMarkdown(line))).filter((line) => line && !isNoiseLine(line));
	for (const line of lines) {
		const detail = pickSummaryDetail(buildSummarySignals(line, descriptor.summaryPatterns ?? []), descriptor.summaryPreference ?? DEFAULT_SUMMARY_PREFERENCE);
		if (detail) return detail;
	}
}
function buildSummarySignals(line, patterns) {
	return {
		line,
		matched: patterns.map((pattern) => line.match(pattern)?.[1]?.trim()).find((value) => Boolean(value)),
		code: extractFirstCodeSpan(line),
		quoted: extractFirstQuotedText(line),
		url: extractFirstUrl(line)
	};
}
function pickSummaryDetail(signals, preference) {
	for (const key of preference) {
		const value = signals[key];
		if (value) return value;
	}
}
function buildResultBlock(source, descriptor) {
	if (source.result == null) return void 0;
	if (descriptor && [
		"Read",
		"Edit",
		"Fetch web page",
		"Browser"
	].includes(descriptor.title)) return;
	return buildDisplayBlock(sanitizeDisplayBlockValue(source.result, descriptor));
}
function buildErrorBlock(error, descriptor) {
	return buildDisplayBlock(sanitizeDisplayBlockValue(error, descriptor), "text");
}
function sanitizeDisplayBlockValue(value, descriptor) {
	if (descriptor?.sanitizer === "command" && typeof value === "string") return redactInlineSecrets(value);
	return value;
}
function buildPatternDetail(params, options) {
	const pattern = extractScalarText(params.pattern);
	const target = extractScalarText(params.glob ?? params.path ?? params.file_path);
	if (pattern && target && options.includeTarget) return `${pattern} in ${target}`;
	return pattern ?? target ?? void 0;
}
function extractScalarText(value) {
	if (typeof value === "string") return value.trim() || void 0;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
}
function sanitizeToolDetail(kind, value, options) {
	if (kind === "command") {
		const cleaned = normalizeInlineDisplayText(value);
		if (!cleaned) return void 0;
		return sanitizeCommandLike(cleaned, options);
	}
	const cleaned = sanitizeGenericText(value);
	if (!cleaned) return void 0;
	switch (kind) {
		case "skill": return cleaned.replace(/^skill\s+/i, "").replace(/[-_]+/g, " ").trim() || "skill";
		case "path": return sanitizePathLike(cleaned, options);
		case "search": return stripQuotes(cleaned);
		case "url": return stripQuotes(cleaned).replace(/^from\s+/i, "");
		default: return cleaned;
	}
}
function normalizeInlineDisplayText(value) {
	return value.replace(/\s+/g, " ").trim();
}
function sanitizePathLike(value, options) {
	const cleaned = sanitizeGenericText(value).replace(/^(?:from|file|path)\s+/i, "").trim();
	if (options.showFullPaths) return cleaned;
	const skillMatch = cleaned.match(/(?:^|\/)skills\/([^/]+)\//i);
	if (skillMatch?.[1]) return skillMatch[1].replace(/[-_]+/g, " ").trim() || cleaned;
	return cleaned.split(/[\\/]/).filter(Boolean).at(-1) ?? cleaned;
}
function sanitizeCommandLike(value, options) {
	const cleaned = stripQuotes(value).replace(/^(?:command|script|description)\s+/i, "").replace(/^.*?\s+->\s+/i, "").trim();
	if (!cleaned) return "command";
	const redacted = redactInlineSecrets(cleaned);
	return options.showFullPaths ? redacted : redactCommandPaths(redacted);
}
function resolveStepStatus(source) {
	if (source.error) return "error";
	if (source.status) return source.status;
	return "success";
}
function buildDisplayBlock(value, fallbackLanguage = "json") {
	if (value == null) return void 0;
	if (typeof value === "string") {
		const normalized = value.replace(/\r\n/g, "\n").trim();
		if (!normalized) return void 0;
		const parsed = tryParseJson(normalized);
		if (parsed && typeof parsed === "object") {
			const prettyJson = stringifyJson(parsed);
			if (prettyJson) return {
				language: "json",
				content: prettyJson
			};
		}
		return {
			language: fallbackLanguage === "json" ? "text" : fallbackLanguage,
			content: normalized
		};
	}
	if (typeof value === "object") {
		const prettyJson = stringifyJson(value);
		if (prettyJson) return {
			language: "json",
			content: prettyJson
		};
	}
	const normalized = String(value).trim();
	return normalized ? {
		language: "text",
		content: normalized
	} : void 0;
}
function stringifyJson(value) {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return;
	}
}
function tryParseJson(value) {
	const trimmed = value.trim();
	if (!trimmed || !/^(?:\{|\[)/.test(trimmed)) return;
	try {
		return JSON.parse(trimmed);
	} catch {
		return;
	}
}
function redactCommandPaths(command) {
	return command.split(/(\s+)/).map((segment) => {
		if (!segment || /^\s+$/.test(segment)) return segment;
		return redactCommandToken(segment);
	}).join("");
}
function redactCommandToken(token) {
	const match = token.match(/^([("'`]*)(.*?)([)"'`,;:]*)$/);
	if (!match) return token;
	const [, prefix, rawCore, suffix] = match;
	return `${prefix}${redactPathAssignment(rawCore)}${suffix}`;
}
function redactPathAssignment(value) {
	const equalsIndex = value.indexOf("=");
	if (equalsIndex > 0) return `${value.slice(0, equalsIndex + 1)}${redactStandalonePath(value.slice(equalsIndex + 1))}`;
	return redactStandalonePath(value);
}
function redactStandalonePath(value) {
	if (/^https?:\/\//i.test(value)) return sanitizeUrlForDisplay(value);
	if (!looksLikePathToken(value)) return value;
	return basenameFromPath(value);
}
function sanitizeUrlForDisplay(url) {
	try {
		const parsed = new URL(url);
		parsed.username = "";
		parsed.password = "";
		for (const key of [...parsed.searchParams.keys()]) if (/(secret|token|password|key|credential|bearer|auth)/i.test(key)) parsed.searchParams.set(key, "[redacted]");
		return parsed.toString();
	} catch {
		return url;
	}
}
function looksLikePathToken(value) {
	return value.startsWith("~/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("/") || value.includes("/");
}
function basenameFromPath(value) {
	return value.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean).at(-1) ?? value;
}
function isSkillPathValue(value) {
	return /(?:^|\/)skills\/[^/]+\//i.test(value);
}
function sanitizeGenericText(value) {
	return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
function cleanupLine(line) {
	return line.replace(/^[-*•]\s*/, "").replace(/^\d+[.)]\s*/, "").replace(/\s+/g, " ").trim();
}
function stripMarkdown(line) {
	return line.replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/^>\s*/, "").trim();
}
function isNoiseLine(line) {
	return /^(?:completed|complete|done|success|succeeded|running|started|finished|ok)$/i.test(line);
}
function humanizeToolName(name) {
	const cleaned = name.replace(/[-_]+/g, " ").trim();
	if (!cleaned) return "Tool";
	return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
function formatDurationLabel(durationMs) {
	return durationMs < 1e3 ? `${durationMs} ms` : `${(durationMs / 1e3).toFixed(1)} s`;
}
function stripQuotes(value) {
	return value.replace(/^[`'"]+|[`'"]+$/g, "").trim();
}
function extractFirstCodeSpan(value) {
	return value.match(/`([^`]+)`/)?.[1]?.trim() || void 0;
}
function extractFirstQuotedText(value) {
	return value.match(/["']([^"']+)["']/)?.[1]?.trim() || void 0;
}
function extractFirstUrl(value) {
	return value.match(/\bhttps?:\/\/[^\s"'`]+/i)?.[0]?.trim() || void 0;
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/card/builder.ts
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Interactive card building for Lark/Feishu.
*
* Provides utilities to construct Feishu Interactive Message Cards for
* different agent response states (thinking, streaming, complete, confirm).
*/
/**
* Element ID used for the streaming text area in cards. The CardKit
* `cardElement.content()` API targets this element for typewriter-effect
* streaming updates.
*/
const STREAMING_ELEMENT_ID = "streaming_content";
const TOOL_USE_STEP_CONTENT_INDENT = "0px 0px 0px 22px";
const REASONING_PREFIX = "Reasoning:\n";
/**
* Split a payload text into optional `reasoningText` and `answerText`.
*
* Handles two formats produced by the framework:
* 1. "Reasoning:\n_italic line_\n…" prefix (from `formatReasoningMessage`)
* 2. `<think>…</think>` / `<thinking>…</thinking>` XML tags
*
* Equivalent to the framework's `splitTelegramReasoningText()`.
*/
function splitReasoningText(text) {
	if (typeof text !== "string" || !text.trim()) return {};
	const trimmed = text.trim();
	if (trimmed.startsWith(REASONING_PREFIX) && trimmed.length > 11) return { reasoningText: cleanReasoningPrefix(trimmed) };
	const taggedReasoning = extractThinkingContent(text);
	const strippedAnswer = stripReasoningTags(text);
	if (!taggedReasoning && strippedAnswer === text) return { answerText: text };
	return {
		reasoningText: taggedReasoning || void 0,
		answerText: strippedAnswer || void 0
	};
}
/**
* Extract content from `<think>`, `<thinking>`, `<thought>` blocks.
* Handles both closed and unclosed (streaming) tags.
*/
function extractThinkingContent(text) {
	if (!text) return "";
	const scanRe = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
	let result = "";
	let lastIndex = 0;
	let inThinking = false;
	for (const match of text.matchAll(scanRe)) {
		const idx = match.index ?? 0;
		if (inThinking) result += text.slice(lastIndex, idx);
		inThinking = match[1] !== "/";
		lastIndex = idx + match[0].length;
	}
	if (inThinking) result += text.slice(lastIndex);
	return result.trim();
}
/**
* Strip reasoning blocks — both XML tags with their content and any
* "Reasoning:\n" prefixed content.
*/
function stripReasoningTags(text) {
	let result = text.replace(/<\s*(?:think(?:ing)?|thought|antthinking)\s*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi, "");
	result = result.replace(/<\s*(?:think(?:ing)?|thought|antthinking)\s*>[\s\S]*$/gi, "");
	result = result.replace(/<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi, "");
	return result.trim();
}
/**
* Clean a "Reasoning:\n_italic_" formatted message back to plain text.
* Strips the prefix and per-line italic markdown wrappers.
*/
function cleanReasoningPrefix(text) {
	let cleaned = text.replace(/^Reasoning:\s*/i, "");
	cleaned = cleaned.split("\n").map((line) => line.replace(/^_(.+)_$/, "$1")).join("\n");
	return cleaned.trim();
}
/**
* Format reasoning duration into a human-readable i18n pair.
* e.g. { zh: "思考了 3.2s", en: "Thought for 3.2s" }
*/
function formatReasoningDuration(ms) {
	const d = formatElapsed(ms);
	return {
		zh: `思考了 ${d}`,
		en: `Thought for ${d}`
	};
}
/**
* Format tool-use duration into a human-readable i18n pair.
*/
function formatToolUseDuration(ms) {
	const d = formatElapsed(ms);
	return {
		zh: `执行耗时 ${d}`,
		en: `Tool use for ${d}`
	};
}
/**
* Format milliseconds into a human-readable duration string.
*/
function formatElapsed(ms) {
	const seconds = ms / 1e3;
	return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
/**
* Build footer meta-info: notation-sized text with i18n support.
* Error text is rendered in red; normal text uses default grey (notation).
*/
function buildFooter(zhText, enText, isError) {
	const zhContent = isError ? `<font color='red'>${zhText}</font>` : zhText;
	const enContent = isError ? `<font color='red'>${enText}</font>` : enText;
	return [{
		tag: "markdown",
		content: enContent,
		i18n_content: {
			zh_cn: zhContent,
			en_us: enContent
		},
		text_size: "notation"
	}];
}
function compactNumber(value) {
	const abs = Math.abs(value);
	if (abs >= 1e6) {
		const m = value / 1e6;
		return Math.abs(m) >= 100 ? `${Math.round(m)}m` : `${m.toFixed(1)}m`;
	}
	if (abs >= 1e3) {
		const k = value / 1e3;
		return Math.abs(k) >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
	}
	return `${Math.round(value)}`;
}
function formatFooterRuntimeSegments(params) {
	const { footer, metrics, elapsedMs, isError, isAborted } = params;
	const primaryZh = [];
	const primaryEn = [];
	const detailZh = [];
	const detailEn = [];
	if (footer?.status) if (isError) {
		primaryZh.push("出错");
		primaryEn.push("Error");
	} else if (isAborted) {
		primaryZh.push("已停止");
		primaryEn.push("Stopped");
	} else {
		primaryZh.push("已完成");
		primaryEn.push("Completed");
	}
	if (footer?.elapsed && elapsedMs != null) {
		const d = formatElapsed(elapsedMs);
		primaryZh.push(`耗时 ${d}`);
		primaryEn.push(`Elapsed ${d}`);
	}
	if (footer?.model && metrics?.model) {
		const model = metrics.model.trim();
		if (model) {
			primaryZh.push(model);
			primaryEn.push(model);
		}
	}
	if (footer?.tokens && metrics) {
		const inTokens = typeof metrics.inputTokens === "number" ? Math.max(0, metrics.inputTokens) : void 0;
		const outTokens = typeof metrics.outputTokens === "number" ? Math.max(0, metrics.outputTokens) : void 0;
		if (inTokens != null && outTokens != null) {
			const inLabel = compactNumber(inTokens);
			const outLabel = compactNumber(outTokens);
			detailZh.push(`↑ ${inLabel} ↓ ${outLabel}`);
			detailEn.push(`↑ ${inLabel} ↓ ${outLabel}`);
		}
	}
	if (footer?.cache && metrics) {
		const read = typeof metrics.cacheRead === "number" ? Math.max(0, metrics.cacheRead) : void 0;
		const write = typeof metrics.cacheWrite === "number" ? Math.max(0, metrics.cacheWrite) : void 0;
		const inputVal = typeof metrics.inputTokens === "number" ? Math.max(0, metrics.inputTokens) : void 0;
		if (read != null && write != null && inputVal != null) {
			const total = read + write + inputVal;
			const hit = total > 0 ? Math.round(read / total * 100) : 0;
			const left = compactNumber(read);
			const right = compactNumber(write);
			detailZh.push(`缓存 ${left}/${right} (${hit}%)`);
			detailEn.push(`Cache ${left}/${right} (${hit}%)`);
		}
	}
	if (footer?.context && metrics) {
		const freshTotal = metrics.totalTokensFresh === false ? void 0 : metrics.totalTokens;
		const total = typeof freshTotal === "number" ? Math.max(0, freshTotal) : void 0;
		const ctx = typeof metrics.contextTokens === "number" ? Math.max(0, metrics.contextTokens) : void 0;
		if (total != null && ctx != null) {
			const totalLabel = compactNumber(total);
			const ctxLabel = compactNumber(ctx);
			const pctLabel = `${ctx > 0 ? Math.round(total / ctx * 100) : 0}%`;
			detailZh.push(`上下文 ${totalLabel}/${ctxLabel} (${pctLabel})`);
			detailEn.push(`Context ${totalLabel}/${ctxLabel} (${pctLabel})`);
		}
	}
	return {
		primaryZh,
		primaryEn,
		detailZh,
		detailEn
	};
}
/**
* Build a full Feishu Interactive Message Card JSON object for the
* given state.
*/
function buildCardContent(state, data = {}) {
	switch (state) {
		case "thinking": return buildThinkingCard();
		case "streaming": return buildStreamingCard(data.text ?? "", {
			reasoningText: data.reasoningText,
			showToolUse: data.showToolUse,
			toolUseSteps: data.toolUseSteps,
			toolUseTitleSuffix: data.toolUseTitleSuffix
		});
		case "complete": return buildCompleteCard({
			text: data.text ?? "",
			elapsedMs: data.elapsedMs,
			isError: data.isError,
			reasoningText: data.reasoningText,
			reasoningElapsedMs: data.reasoningElapsedMs,
			toolUseSteps: data.toolUseSteps,
			toolUseTitleSuffix: data.toolUseTitleSuffix,
			toolUseElapsedMs: data.toolUseElapsedMs,
			showToolUse: data.showToolUse,
			isAborted: data.isAborted,
			footer: data.footer,
			footerMetrics: data.footerMetrics
		});
		case "confirm": return buildConfirmCard(data.confirmData);
		default: throw new Error(`Unknown card state: ${state}`);
	}
}
function buildThinkingCard() {
	return {
		config: {
			wide_screen_mode: true,
			update_multi: true,
			locales: ["zh_cn", "en_us"]
		},
		elements: [{
			tag: "markdown",
			content: "Thinking...",
			i18n_content: {
				zh_cn: "思考中...",
				en_us: "Thinking..."
			}
		}]
	};
}
function buildStreamingCard(partialText, params = {}) {
	const { showToolUse = true, toolUseSteps, toolUseTitleSuffix, reasoningText } = params;
	const elements = [];
	const hasToolUse = Boolean(toolUseSteps?.length);
	if (showToolUse && hasToolUse) elements.push(buildToolUsePanel({
		toolUseSteps,
		titleSuffix: toolUseTitleSuffix
	}));
	if (!partialText && reasoningText) elements.push({
		tag: "markdown",
		content: `💭 **Thinking...**\n\n${reasoningText}`,
		i18n_content: {
			zh_cn: `💭 **思考中...**\n\n${reasoningText}`,
			en_us: `💭 **Thinking...**\n\n${reasoningText}`
		},
		text_size: "notation"
	});
	else if (partialText) elements.push({
		tag: "markdown",
		content: optimizeMarkdownStyle(partialText)
	});
	return {
		config: {
			wide_screen_mode: true,
			update_multi: true,
			locales: ["zh_cn", "en_us"]
		},
		elements
	};
}
function buildCompleteCard(params) {
	const { text, elapsedMs, isError, reasoningText, reasoningElapsedMs, toolUseSteps, toolUseTitleSuffix, toolUseElapsedMs, showToolUse = true, isAborted, footer, footerMetrics } = params;
	const elements = [];
	if (showToolUse && toolUseSteps?.length) elements.push(buildToolUsePanel({
		toolUseSteps,
		toolUseElapsedMs,
		titleSuffix: toolUseTitleSuffix
	}));
	if (reasoningText) {
		const dur = reasoningElapsedMs ? formatReasoningDuration(reasoningElapsedMs) : null;
		const zhLabel = dur ? dur.zh : "思考";
		const enLabel = dur ? dur.en : "Thought";
		elements.push({
			tag: "collapsible_panel",
			expanded: false,
			header: {
				title: {
					tag: "markdown",
					content: `💭 ${enLabel}`,
					i18n_content: {
						zh_cn: `💭 ${zhLabel}`,
						en_us: `💭 ${enLabel}`
					}
				},
				vertical_align: "center",
				icon: {
					tag: "standard_icon",
					token: "down-small-ccm_outlined",
					size: "16px 16px"
				},
				icon_position: "follow_text",
				icon_expanded_angle: -180
			},
			border: {
				color: "grey",
				corner_radius: "5px"
			},
			vertical_spacing: "8px",
			padding: "8px 8px 8px 8px",
			elements: [{
				tag: "markdown",
				content: reasoningText,
				text_size: "notation"
			}]
		});
	}
	elements.push({
		tag: "markdown",
		content: optimizeMarkdownStyle(text)
	});
	const fp = formatFooterRuntimeSegments({
		footer,
		metrics: footerMetrics,
		elapsedMs,
		isError,
		isAborted
	});
	const footerZhLines = [];
	const footerEnLines = [];
	if (fp.primaryZh.length > 0) {
		footerZhLines.push(fp.primaryZh.join(" · "));
		footerEnLines.push(fp.primaryEn.join(" · "));
	}
	if (fp.detailZh.length > 0) {
		footerZhLines.push(fp.detailZh.join(" · "));
		footerEnLines.push(fp.detailEn.join(" · "));
	}
	if (footerZhLines.length > 0) elements.push(...buildFooter(footerZhLines.join("\n"), footerEnLines.join("\n"), isError));
	const summaryText = text.replace(/[*_`#>[\]()~]/g, "").trim();
	return {
		config: {
			wide_screen_mode: true,
			update_multi: true,
			locales: ["zh_cn", "en_us"],
			summary: summaryText ? { content: summaryText.slice(0, 120) } : void 0
		},
		elements
	};
}
function buildConfirmCard(confirmData) {
	const elements = [];
	elements.push({
		tag: "div",
		text: {
			tag: "lark_md",
			content: confirmData.operationDescription
		}
	});
	if (confirmData.preview) {
		elements.push({ tag: "hr" });
		elements.push({
			tag: "div",
			text: {
				tag: "lark_md",
				content: `**Preview:**\n${confirmData.preview}`
			}
		});
	}
	elements.push({ tag: "hr" });
	elements.push({
		tag: "action",
		actions: [
			{
				tag: "button",
				text: {
					tag: "plain_text",
					content: "Confirm"
				},
				type: "primary",
				value: {
					action: "confirm_write",
					operation_id: confirmData.pendingOperationId
				}
			},
			{
				tag: "button",
				text: {
					tag: "plain_text",
					content: "Reject"
				},
				type: "danger",
				value: {
					action: "reject_write",
					operation_id: confirmData.pendingOperationId
				}
			},
			...confirmData.preview ? [] : [{
				tag: "button",
				text: {
					tag: "plain_text",
					content: "Preview"
				},
				type: "default",
				value: {
					action: "preview_write",
					operation_id: confirmData.pendingOperationId
				}
			}]
		]
	});
	return {
		config: {
			wide_screen_mode: true,
			update_multi: true
		},
		header: {
			title: {
				tag: "plain_text",
				content: "🔒 Confirmation Required"
			},
			template: "orange"
		},
		elements
	};
}
/**
* Convert an old-format FeishuCard to CardKit JSON 2.0 format.
* JSON 2.0 uses `body.elements` instead of top-level `elements`.
*/
/**
* Build the initial CardKit 2.0 streaming card with a loading icon.
* Optionally includes a tool-use pending panel above the streaming area.
*/
function buildStreamingThinkingCard(showToolUse = true) {
	return buildStreamingPreAnswerCard({ showToolUse });
}
/**
* Build a CardKit 2.0 card for the pre-answer streaming phase.
* Used both for the initial card and for live updates during tool calls.
*/
function buildStreamingPreAnswerCard(params) {
	const { steps, elapsedMs, showToolUse = true, text = "" } = params;
	const hasSteps = Boolean(steps?.length);
	const elements = [];
	if (showToolUse && hasSteps && steps) elements.push(buildStreamingToolUseActivePanel({
		steps,
		elapsedMs
	}));
	elements.push({
		tag: "markdown",
		content: text,
		text_align: "left",
		text_size: "normal_v2",
		margin: "0px 0px 0px 0px",
		element_id: STREAMING_ELEMENT_ID
	});
	elements.push({
		tag: "markdown",
		content: " ",
		icon: {
			tag: "custom_icon",
			img_key: "img_v3_02vb_496bec09-4b43-4773-ad6b-0cdd103cd2bg",
			size: "16px 16px"
		},
		element_id: "loading_icon"
	});
	return {
		schema: "2.0",
		config: {
			streaming_mode: true,
			locales: ["zh_cn", "en_us"],
			summary: {
				content: "Processing...",
				i18n_content: {
					zh_cn: "处理中...",
					en_us: "Processing..."
				}
			}
		},
		body: { elements }
	};
}
/**
* Build the collapsible panel for the active pre-answer phase.
* Used by buildStreamingPreAnswerCard when at least one step exists.
*/
function buildStreamingToolUseActivePanel(params) {
	const { steps, elapsedMs } = params;
	const enParts = ["Tool use"];
	const zhParts = ["工具执行"];
	if (steps.length > 0) {
		enParts.push(`${steps.length} step${steps.length === 1 ? "" : "s"}`);
		zhParts.push(`${steps.length} 步`);
	}
	if (elapsedMs != null && elapsedMs > 0) {
		const d = formatElapsed(elapsedMs);
		enParts.push(`(${d})`);
		zhParts.push(`(${d})`);
	}
	return {
		tag: "collapsible_panel",
		expanded: true,
		header: {
			title: {
				tag: "plain_text",
				content: `🛠️ ${enParts.join(" · ")}`,
				i18n_content: {
					zh_cn: `🛠️ ${zhParts.join(" · ")}`,
					en_us: `🛠️ ${enParts.join(" · ")}`
				},
				text_color: "grey",
				text_size: "notation"
			},
			vertical_align: "center",
			icon: {
				tag: "standard_icon",
				token: "down-small-ccm_outlined",
				color: "grey",
				size: "16px 16px"
			},
			icon_position: "right",
			icon_expanded_angle: -180
		},
		border: {
			color: "grey",
			corner_radius: "5px"
		},
		vertical_spacing: "4px",
		padding: "8px 8px 8px 8px",
		elements: steps.flatMap((step) => buildToolUseStepElements(step))
	};
}
function toCardKit2(card) {
	const result = {
		schema: "2.0",
		config: card.config,
		body: { elements: card.elements }
	};
	if (card.header) result.header = card.header;
	return result;
}
function buildToolUsePanel(params) {
	const { toolUseSteps = [], toolUseElapsedMs, titleSuffix } = params;
	const duration = toolUseElapsedMs ? formatToolUseDuration(toolUseElapsedMs) : null;
	const zhTitleParts = [duration?.zh ?? "工具执行"];
	const enTitleParts = [duration?.en ?? "Tool use"];
	if (titleSuffix) {
		zhTitleParts.push(titleSuffix.zh);
		enTitleParts.push(titleSuffix.en);
	}
	const stepElements = toolUseSteps.length > 0 ? toolUseSteps.flatMap((step) => buildToolUseStepElements(step)) : [buildToolUsePlaceholder()];
	return {
		tag: "collapsible_panel",
		expanded: false,
		header: {
			title: {
				tag: "plain_text",
				content: `🛠️ ${enTitleParts.join(" · ")}`,
				i18n_content: {
					zh_cn: `🛠️ ${zhTitleParts.join(" · ")}`,
					en_us: `🛠️ ${enTitleParts.join(" · ")}`
				},
				text_color: "grey",
				text_size: "notation"
			},
			vertical_align: "center",
			icon: {
				tag: "standard_icon",
				token: "down-small-ccm_outlined",
				color: "grey",
				size: "16px 16px"
			},
			icon_position: "right",
			icon_expanded_angle: -180
		},
		border: {
			color: "grey",
			corner_radius: "5px"
		},
		vertical_spacing: "4px",
		padding: "8px 8px 8px 8px",
		elements: stepElements
	};
}
function buildToolUseStepElements(step) {
	const elements = [buildToolUseStepTitleElement(step)];
	const detailElement = buildToolUseStepDetailElement(step);
	if (detailElement) elements.push(detailElement);
	const outputElement = buildToolUseStepOutputElement(step);
	if (outputElement) elements.push(outputElement);
	return elements;
}
function buildToolUsePlaceholder(labels) {
	const zh = labels?.zh ?? "暂无工具步骤";
	const en = labels?.en ?? "No tool steps available";
	return {
		tag: "div",
		text: {
			tag: "plain_text",
			content: en,
			i18n_content: {
				zh_cn: zh,
				en_us: en
			},
			text_color: "grey",
			text_size: "notation"
		}
	};
}
function buildToolUseStepTitleElement(step) {
	return {
		tag: "div",
		icon: {
			tag: "standard_icon",
			token: step.iconToken,
			color: "grey"
		},
		text: {
			tag: "lark_md",
			content: buildToolUseStepTitleMarkdown(step),
			text_size: "notation"
		}
	};
}
function buildToolUseStepTitleMarkdown(step) {
	const status = formatToolUseStepStatus(step.status);
	return optimizeMarkdownStyle(`**${escapeToolUseMarkdownText(step.title)}** · <font color='${status.color}'>${status.label}</font>`, 1);
}
function buildToolUseStepDetailElement(step) {
	const detail = step.detail?.trim();
	if (!detail) return void 0;
	return {
		tag: "div",
		margin: TOOL_USE_STEP_CONTENT_INDENT,
		text: {
			tag: "plain_text",
			content: detail,
			text_color: "grey",
			text_size: "notation"
		}
	};
}
function buildToolUseStepOutputElement(step) {
	const content = buildToolUseStepOutputMarkdown(step);
	if (!content) return void 0;
	return {
		tag: "div",
		margin: TOOL_USE_STEP_CONTENT_INDENT,
		text: {
			tag: "lark_md",
			content,
			text_size: "notation"
		}
	};
}
function buildToolUseStepOutputMarkdown(step) {
	const lines = [];
	if (step.errorBlock) {
		lines.push("**Error**");
		lines.push(formatToolUseCodeBlock(step.errorBlock.content, step.errorBlock.language));
	} else if (step.resultBlock) {
		lines.push("**Result**");
		lines.push(formatToolUseCodeBlock(step.resultBlock.content, step.resultBlock.language));
	}
	if (lines.length === 0) return void 0;
	return optimizeMarkdownStyle(lines.join("\n"), 1);
}
function formatToolUseStepStatus(status) {
	switch (status) {
		case "running": return {
			label: "Running",
			color: "turquoise"
		};
		case "error": return {
			label: "Failed",
			color: "red"
		};
		default: return {
			label: "Succeeded",
			color: "green"
		};
	}
}
function formatToolUseCodeBlock(content, language) {
	const normalized = content.replace(/\r\n/g, "\n").trim();
	const fence = "`".repeat(Math.max(3, longestBacktickRun(normalized) + 1));
	return `${fence}${language}\n${normalized}\n${fence}`;
}
function longestBacktickRun(value) {
	return (value.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
}
function escapeToolUseMarkdownText(value) {
	return value.replace(/\\/g, "\\\\").replace(/([`*_{}[\]<>])/g, "\\$1");
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/card/card-error.ts
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Unified card API error handling.
*
* Provides structured error class for CardKit API responses, sub-error
* parsing for the generic 230099 code, and helper predicates used by
* reply-dispatcher and streaming-card-controller.
*/
/** 卡片 API 级别错误码。 */
const CARD_ERROR = {
	/** 发送频率限制 */
	RATE_LIMITED: 230020,
	/** 卡片内容创建失败（通用码，需检查子错误） */
	CARD_CONTENT_FAILED: 230099
};
/** 230099 子错误码，嵌套在 msg 的 ErrCode 字段中。 */
const CARD_CONTENT_SUB_ERROR = { 
/** 卡片元素（表格等）数量超限 */
ELEMENT_LIMIT: 11310 };
/** CardKit API 返回非零 code 时的结构化错误。 */
var CardKitApiError = class extends Error {
	code;
	msg;
	constructor(params) {
		const { api, code, msg, context } = params;
		super(`cardkit ${api} FAILED: code=${code}, msg=${msg}, ${context}`);
		this.name = "CardKitApiError";
		this.code = code;
		this.msg = msg;
	}
};
/**
* 从 msg 字符串中提取子错误码。
*
* 示例输入: "Failed to create card content, ext=ErrCode: 11310; ErrMsg: element exceeds the limit; code:230099"
* 返回 11310 或 null。
*/
function extractSubCode(msg) {
	const match = /ErrCode:\s*(\d+)/.exec(msg);
	if (!match) return null;
	const code = Number(match[1]);
	return Number.isFinite(code) ? code : null;
}
/**
* 从任意抛错对象中解析卡片 API 错误结构。
*
* 返回 { code, subCode, errMsg }，如果无法提取 code 则返回 null。
*/
function parseCardApiError(err) {
	const code = extractLarkApiCode(err);
	if (code === void 0) return null;
	let errMsg = "";
	if (err && typeof err === "object") {
		const e = err;
		if (typeof e.msg === "string") errMsg = e.msg;
		else if (typeof e.response?.data?.msg === "string") errMsg = e.response.data.msg;
		else if (typeof e.message === "string") errMsg = e.message;
	}
	return {
		code,
		subCode: extractSubCode(errMsg),
		errMsg
	};
}
/**
* 判断错误是否为卡片表格数量超限。
*
* 匹配条件：code 230099 + subCode 11310 + errMsg 含 "table number over limit"。
* 11310 是通用的元素超限码（也覆盖模板可见性、组件上限等），
* 必须同时检查 errMsg 确认是表格数量导致的。
*
* 实际错误格式（生产日志 2026-03-13）：
* "Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit; ErrorValue: table; "
*/
function isCardTableLimitError(err) {
	const parsed = parseCardApiError(err);
	if (!parsed) return false;
	return parsed.code === CARD_ERROR.CARD_CONTENT_FAILED && parsed.subCode === CARD_CONTENT_SUB_ERROR.ELEMENT_LIMIT && /table number over limit/i.test(parsed.errMsg);
}
/** 判断错误是否为卡片发送频率限制（230020）。 */
function isCardRateLimitError(err) {
	const parsed = parseCardApiError(err);
	if (!parsed) return false;
	return parsed.code === CARD_ERROR.RATE_LIMITED;
}
/**
* 收集正文里可被飞书卡片实际渲染的 markdown 表格。
*
* 代码块里的示例表格不会被飞书解析成卡片表格元素，因此这里要先排除，
* 让 shouldUseCard() 预检和 sanitizeTextForCard() 降级逻辑使用同一份结果。
*/
function findMarkdownTablesOutsideCodeBlocks$1(text) {
	const codeBlockRanges = [];
	const codeBlockRegex = /```[\s\S]*?```/g;
	let codeBlockMatch = codeBlockRegex.exec(text);
	while (codeBlockMatch != null) {
		codeBlockRanges.push({
			start: codeBlockMatch.index,
			end: codeBlockMatch.index + codeBlockMatch[0].length
		});
		codeBlockMatch = codeBlockRegex.exec(text);
	}
	const isInsideCodeBlock = (idx) => codeBlockRanges.some((range) => idx >= range.start && idx < range.end);
	const tableRegex = /\|.+\|[\r\n]+\|[-:| ]+\|[\s\S]*?(?=\n\n|\n(?!\|)|$)/g;
	const matches = [];
	let tableMatch = tableRegex.exec(text);
	while (tableMatch != null) {
		if (!isInsideCodeBlock(tableMatch.index)) matches.push({
			index: tableMatch.index,
			length: tableMatch[0].length,
			raw: tableMatch[0]
		});
		tableMatch = tableRegex.exec(text);
	}
	return matches;
}
/**
* 对多段 markdown 文本共享一个表格预算。
*
* 段落按数组顺序消耗额度，适合处理“reasoning + 正文”这类会被飞书
* 作为同一张卡片渲染的多块文本。
*/
function sanitizeTextSegmentsForCard(texts, tableLimit = 3) {
	let remainingTableBudget = tableLimit;
	return texts.map((text) => {
		const matches = findMarkdownTablesOutsideCodeBlocks$1(text);
		if (matches.length <= remainingTableBudget) {
			remainingTableBudget -= matches.length;
			return text;
		}
		const sanitizedText = wrapTablesBeyondLimit(text, matches, Math.max(remainingTableBudget, 0));
		remainingTableBudget = 0;
		return sanitizedText;
	});
}
function wrapTablesBeyondLimit(text, matches, keepCount) {
	if (matches.length <= keepCount) return text;
	let result = text;
	for (let i = matches.length - 1; i >= keepCount; i--) {
		const { index, length, raw } = matches[i];
		const replacement = `\`\`\`\n${raw}\n\`\`\``;
		result = result.slice(0, index) + replacement + result.slice(index + length);
	}
	return result;
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/core/targets.ts
const CHAT_PREFIX = "oc_";
const OPEN_ID_PREFIX = "ou_";
const TAG_CHAT = "chat:";
const TAG_USER = "user:";
const TAG_OPEN_ID = "open_id:";
const TAG_FEISHU = "feishu:";
const ROUTE_META_FRAGMENT_REPLY_TO = "__feishu_reply_to";
const ROUTE_META_FRAGMENT_THREAD_ID = "__feishu_thread_id";
/**
* Strip OpenClaw routing prefixes (`chat:`, `user:`, `open_id:`) from a
* raw target string, returning the bare Feishu identifier.
*
* Returns `null` when the input is empty or falsy.
*/
function normalizeFeishuTarget(raw) {
	if (!raw) return null;
	const trimmed = parseFeishuRouteTarget(raw).target.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith(TAG_FEISHU)) {
		const inner = trimmed.slice(7).trim();
		if (inner) return inner;
	}
	if (trimmed.startsWith(TAG_CHAT)) return trimmed.slice(5);
	if (trimmed.startsWith(TAG_USER)) return trimmed.slice(5);
	if (trimmed.startsWith(TAG_OPEN_ID)) return trimmed.slice(8);
	return trimmed;
}
function parseFeishuRouteTarget(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return { target: "" };
	const hashIndex = trimmed.indexOf("#");
	if (hashIndex < 0) return { target: trimmed };
	const target = trimmed.slice(0, hashIndex).trim();
	const fragment = trimmed.slice(hashIndex + 1).trim();
	if (!fragment) return { target };
	const params = new URLSearchParams(fragment);
	const replyToMessageId = normalizeMessageId(params.get(ROUTE_META_FRAGMENT_REPLY_TO)?.trim() || void 0);
	const threadId = params.get(ROUTE_META_FRAGMENT_THREAD_ID)?.trim() || void 0;
	return {
		target,
		...replyToMessageId ? { replyToMessageId } : {},
		...threadId ? { threadId } : {}
	};
}
/**
* Determine the `receive_id_type` query parameter for the Feishu send-message
* API based on the target identifier.
*/
function resolveReceiveIdType(id) {
	if (id.startsWith(CHAT_PREFIX)) return "chat_id";
	if (id.startsWith(OPEN_ID_PREFIX)) return "open_id";
	return "open_id";
}
function normalizeMessageId(messageId) {
	if (!messageId) return void 0;
	const colonIndex = messageId.indexOf(":");
	if (colonIndex >= 0) return messageId.slice(0, colonIndex);
	return messageId;
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/core/message-unavailable.ts
const UNAVAILABLE_CACHE_TTL_MS = 1800 * 1e3;
const MAX_CACHE_SIZE_BEFORE_PRUNE = 512;
const unavailableMessageCache = /* @__PURE__ */ new Map();
function pruneExpired(nowMs = Date.now()) {
	for (const [messageId, state] of unavailableMessageCache) if (nowMs - state.markedAtMs > UNAVAILABLE_CACHE_TTL_MS) unavailableMessageCache.delete(messageId);
}
function isTerminalMessageApiCode(code) {
	return typeof code === "number" && MESSAGE_TERMINAL_CODES$1.has(code);
}
function markMessageUnavailable(params) {
	const normalizedId = normalizeMessageId(params.messageId);
	if (!normalizedId) return;
	if (unavailableMessageCache.size >= MAX_CACHE_SIZE_BEFORE_PRUNE) pruneExpired();
	unavailableMessageCache.set(normalizedId, {
		apiCode: params.apiCode,
		operation: params.operation,
		markedAtMs: Date.now()
	});
}
function getMessageUnavailableState(messageId) {
	const normalizedId = normalizeMessageId(messageId);
	if (!normalizedId) return void 0;
	const state = unavailableMessageCache.get(normalizedId);
	if (!state) return void 0;
	if (Date.now() - state.markedAtMs > UNAVAILABLE_CACHE_TTL_MS) {
		unavailableMessageCache.delete(normalizedId);
		return;
	}
	return state;
}
function isMessageUnavailable(messageId) {
	return !!getMessageUnavailableState(messageId);
}
function markMessageUnavailableFromError(params) {
	const normalizedId = normalizeMessageId(params.messageId);
	if (!normalizedId) return void 0;
	const code = extractLarkApiCode(params.error);
	if (!isTerminalMessageApiCode(code)) return void 0;
	markMessageUnavailable({
		messageId: normalizedId,
		apiCode: code,
		operation: params.operation
	});
	return code;
}
var MessageUnavailableError = class extends Error {
	messageId;
	apiCode;
	operation;
	constructor(params) {
		const operationText = params.operation ? `, op=${params.operation}` : "";
		super(`[feishu-message-unavailable] message ${params.messageId} unavailable (code=${params.apiCode}${operationText})`);
		this.name = "MessageUnavailableError";
		this.messageId = params.messageId;
		this.apiCode = params.apiCode;
		this.operation = params.operation;
	}
};
function isMessageUnavailableError(error) {
	return error instanceof MessageUnavailableError || typeof error === "object" && error != null && error.name === "MessageUnavailableError";
}
function assertMessageAvailable(messageId, operation) {
	const normalizedId = normalizeMessageId(messageId);
	if (!normalizedId) return;
	const state = getMessageUnavailableState(normalizedId);
	if (!state) return;
	throw new MessageUnavailableError({
		messageId: normalizedId,
		apiCode: state.apiCode,
		operation: operation ?? state.operation
	});
}
/**
* 针对 message_id 的统一保护：
* - 调用前检查是否已标记不可用；
* - 调用报错后识别 230011/231003 并标记；
* - 命中时抛出 MessageUnavailableError 供上游快速终止流程。
*/
async function runWithMessageUnavailableGuard(params) {
	const normalizedId = normalizeMessageId(params.messageId);
	if (!normalizedId) return params.fn();
	assertMessageAvailable(normalizedId, params.operation);
	try {
		return await params.fn();
	} catch (error) {
		const code = markMessageUnavailableFromError({
			messageId: normalizedId,
			error,
			operation: params.operation
		});
		if (code) throw new MessageUnavailableError({
			messageId: normalizedId,
			apiCode: code,
			operation: params.operation
		});
		throw error;
	}
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/card/cardkit.ts
const log$6 = larkLogger$1("card/cardkit");
/**
* 记录 CardKit API 响应日志，检测错误码并抛出异常。
*
* 默认 fail-fast：body-level 非零 code 视为业务错误，立即抛出，
* 由调用方（streaming-card-controller 等）统一走 catch → guard 处理。
*/
function logCardKitResponse(params) {
	const { resp, api, context } = params;
	const { code, msg } = resp;
	log$6.info(`cardkit ${api} response`, {
		code,
		msg,
		context
	});
	if (code && code !== 0) {
		log$6.warn(`cardkit ${api} FAILED`, {
			code,
			msg,
			context,
			fullResponse: resp
		});
		throw new CardKitApiError({
			api,
			code,
			msg: msg ?? "",
			context
		});
	}
}
/**
* Create a card entity via the CardKit API.
*
* Returns the card_id directly, bypassing the idConvert step.
* The card can then be sent via IM API and streamed via CardKit.
*/
async function createCardEntity(params) {
	const { cfg, card, accountId } = params;
	const response = await LarkClient.fromCfg(cfg, accountId).sdk.cardkit.v1.card.create({ data: {
		type: "card_json",
		data: JSON.stringify(card)
	} });
	const cardId = response.data?.card_id ?? response.card_id ?? null;
	logCardKitResponse({
		resp: response,
		api: "card.create",
		context: `cardId=${cardId}`
	});
	return cardId;
}
/**
* Stream text content to a specific card element using the CardKit API.
*
* The card automatically diffs the new content against the previous
* content and renders incremental changes with a typewriter animation.
*
* @param params.cardId    - CardKit card ID (from `convertMessageToCardId`).
* @param params.elementId - The element ID to update (e.g. `STREAMING_ELEMENT_ID`).
* @param params.content   - The full cumulative text (not a delta).
* @param params.sequence  - Monotonically increasing sequence number.
*/
async function streamCardContent(params) {
	const { cfg, cardId, elementId, content, sequence, accountId } = params;
	logCardKitResponse({
		resp: await LarkClient.fromCfg(cfg, accountId).sdk.cardkit.v1.cardElement.content({
			data: {
				content,
				sequence
			},
			path: {
				card_id: cardId,
				element_id: elementId
			}
		}),
		api: "cardElement.content",
		context: `seq=${sequence}, contentLen=${content.length}`
	});
}
/**
* Fully replace a card using the CardKit API.
*
* Used for the final "complete" state update (with action buttons, green
* header, etc.) after streaming finishes.
*
* @param params.cardId   - CardKit card ID.
* @param params.card     - The new card JSON content.
* @param params.sequence - Monotonically increasing sequence number.
*/
async function updateCardKitCard(params) {
	const { cfg, cardId, card, sequence, accountId } = params;
	logCardKitResponse({
		resp: await LarkClient.fromCfg(cfg, accountId).sdk.cardkit.v1.card.update({
			data: {
				card: {
					type: "card_json",
					data: JSON.stringify(card)
				},
				sequence
			},
			path: { card_id: cardId }
		}),
		api: "card.update",
		context: `seq=${sequence}, cardId=${cardId}`
	});
}
/**
* Send an interactive card message by referencing a CardKit card_id.
*
* The content format is: {"type":"card","data":{"card_id":"xxx"}}
* This links the IM message to the CardKit card entity, enabling
* streaming updates via cardElement.content().
*/
async function sendCardByCardId(params) {
	const { cfg, to, cardId, replyToMessageId, replyInThread, accountId } = params;
	const client = LarkClient.fromCfg(cfg, accountId).sdk;
	const contentPayload = JSON.stringify({
		type: "card",
		data: { card_id: cardId }
	});
	if (replyToMessageId) {
		const normalizedId = normalizeMessageId(replyToMessageId);
		const response = await runWithMessageUnavailableGuard({
			messageId: normalizedId,
			operation: "im.message.reply(interactive.cardkit)",
			fn: () => client.im.message.reply({
				path: { message_id: normalizedId },
				data: {
					content: contentPayload,
					msg_type: "interactive",
					reply_in_thread: replyInThread
				}
			})
		});
		return {
			messageId: response?.data?.message_id ?? "",
			chatId: response?.data?.chat_id ?? ""
		};
	}
	const target = normalizeFeishuTarget(to);
	if (!target) throw new Error(`[feishu-send] Invalid target: "${to}"`);
	const receiveIdType = resolveReceiveIdType(target);
	const response = await client.im.message.create({
		params: { receive_id_type: receiveIdType },
		data: {
			receive_id: target,
			...params.uuid ? { uuid: params.uuid } : {},
			msg_type: "interactive",
			content: contentPayload
		}
	});
	return {
		messageId: response?.data?.message_id ?? "",
		chatId: response?.data?.chat_id ?? ""
	};
}
/**
* Close (or open) the streaming mode on a CardKit card.
*
* Must be called after streaming is complete to restore normal card
* behaviour (forwarding, interaction callbacks, etc.).
*/
async function setCardStreamingMode(params) {
	const { cfg, cardId, streamingMode, sequence, accountId } = params;
	logCardKitResponse({
		resp: await LarkClient.fromCfg(cfg, accountId).sdk.cardkit.v1.card.settings({
			data: {
				settings: JSON.stringify({ streaming_mode: streamingMode }),
				sequence
			},
			path: { card_id: cardId }
		}),
		api: "card.settings",
		context: `seq=${sequence}, streaming_mode=${streamingMode}`
	});
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/card/reply-dispatcher-types.ts
const TERMINAL_PHASES = new Set([
	"completed",
	"aborted",
	"terminated",
	"creation_failed"
]);
const PHASE_TRANSITIONS = {
	idle: new Set([
		"creating",
		"aborted",
		"terminated"
	]),
	creating: new Set([
		"streaming",
		"creation_failed",
		"aborted",
		"terminated"
	]),
	streaming: new Set([
		"completed",
		"aborted",
		"terminated"
	]),
	completed: /* @__PURE__ */ new Set(),
	aborted: /* @__PURE__ */ new Set(),
	terminated: /* @__PURE__ */ new Set(),
	creation_failed: /* @__PURE__ */ new Set()
};
/**
* Throttle intervals for card updates.
*
* - `CARDKIT_MS`: CardKit `cardElement.content()` — designed for streaming,
*   low throttle is fine.
* - `PATCH_MS`: `im.message.patch` — strict rate limits (code 230020).
* - `LONG_GAP_THRESHOLD_MS`: After a long idle gap (tool call / LLM thinking),
*   defer the first flush briefly.
* - `BATCH_AFTER_GAP_MS`: Batching window after a long gap.
*/
const THROTTLE_CONSTANTS = {
	CARDKIT_MS: 100,
	PATCH_MS: 1500,
	LONG_GAP_THRESHOLD_MS: 2e3,
	BATCH_AFTER_GAP_MS: 300,
	REASONING_STATUS_MS: 1500
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/card/flush-controller.ts
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Generic throttled flush controller.
*
* A pure scheduling primitive that manages timer-based throttling,
* mutex-guarded flushing, and reflush-on-conflict. Contains no
* business logic — the actual flush work is provided via a callback.
*/
var FlushController = class {
	flushInProgress = false;
	flushResolvers = [];
	needsReflush = false;
	pendingFlushTimer = null;
	lastUpdateTime = 0;
	isCompleted = false;
	constructor(doFlush) {
		this.doFlush = doFlush;
	}
	/** Mark the controller as completed — no more flushes after current one. */
	complete() {
		this.isCompleted = true;
	}
	/** Cancel any pending deferred flush timer. */
	cancelPendingFlush() {
		if (this.pendingFlushTimer) {
			clearTimeout(this.pendingFlushTimer);
			this.pendingFlushTimer = null;
		}
	}
	/** Wait for any in-progress flush to finish. */
	waitForFlush() {
		if (!this.flushInProgress) return Promise.resolve();
		return new Promise((resolve) => this.flushResolvers.push(resolve));
	}
	/**
	* Execute a flush (mutex-guarded, with reflush on conflict).
	*
	* If a flush is already in progress, marks needsReflush so a
	* follow-up flush fires immediately after the current one completes.
	*/
	async flush() {
		if (!this.cardMessageReady() || this.flushInProgress || this.isCompleted) {
			if (this.flushInProgress && !this.isCompleted) this.needsReflush = true;
			return;
		}
		this.flushInProgress = true;
		this.needsReflush = false;
		this.lastUpdateTime = Date.now();
		try {
			await this.doFlush();
			this.lastUpdateTime = Date.now();
		} finally {
			this.flushInProgress = false;
			const resolvers = this.flushResolvers;
			this.flushResolvers = [];
			for (const resolve of resolvers) resolve();
			if (this.needsReflush && !this.isCompleted && !this.pendingFlushTimer) {
				this.needsReflush = false;
				this.pendingFlushTimer = setTimeout(() => {
					this.pendingFlushTimer = null;
					this.flush();
				}, 0);
			}
		}
	}
	/**
	* Throttled update entry point.
	*
	* @param throttleMs - Minimum interval between flushes (varies by
	*   CardKit vs IM patch mode). Passed in by the caller so this
	*   controller remains business-logic-free.
	*/
	async throttledUpdate(throttleMs) {
		if (!this.cardMessageReady()) return;
		const now = Date.now();
		const elapsed = now - this.lastUpdateTime;
		if (elapsed >= throttleMs) {
			this.cancelPendingFlush();
			if (elapsed > THROTTLE_CONSTANTS.LONG_GAP_THRESHOLD_MS) {
				this.lastUpdateTime = now;
				this.pendingFlushTimer = setTimeout(() => {
					this.pendingFlushTimer = null;
					this.flush();
				}, THROTTLE_CONSTANTS.BATCH_AFTER_GAP_MS);
			} else await this.flush();
		} else if (!this.pendingFlushTimer) {
			const delay = throttleMs - elapsed;
			this.pendingFlushTimer = setTimeout(() => {
				this.pendingFlushTimer = null;
				this.flush();
			}, delay);
		}
	}
	/** Overridable gate: subclasses / consumers can set via setCardMessageReady. */
	_cardMessageReady = false;
	cardMessageReady() {
		return this._cardMessageReady;
	}
	setCardMessageReady(ready) {
		this._cardMessageReady = ready;
		if (ready) this.lastUpdateTime = Date.now();
	}
};
//#endregion
//#region media.ts
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const systemFetch = globalThis.fetch;
const blockedIpv4 = new net.BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4]
]) blockedIpv4.addSubnet(network, prefix, "ipv4");
const blockedIpv6 = new net.BlockList();
for (const [network, prefix] of [
	["::", 128],
	["::1", 128],
	["::", 96],
	["::ffff:0:0", 96],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
	["2001:db8::", 32]
]) blockedIpv6.addSubnet(network, prefix, "ipv6");
function privateAddress(address) {
	const family = net.isIP(address);
	if (family === 4) return blockedIpv4.check(address, "ipv4");
	if (family === 6) return blockedIpv6.check(address, "ipv6");
	return true;
}
async function validateRemoteImage(raw) {
	const url = new URL(raw);
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP(S) image URLs are supported");
	if (url.username || url.password) throw new Error("Image URL credentials are not allowed");
	const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
	const family = net.isIP(hostname);
	const addresses = family ? [{
		address: hostname,
		family
	}] : await dns.lookup(hostname, {
		all: true,
		verbatim: true
	});
	if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) throw new Error("Private image URL is not allowed");
	return {
		url,
		selected: addresses[0]
	};
}
function fixedLookup(selected) {
	return (_hostname, options, callback) => {
		if (options.all) callback(null, [selected]);
		else callback(null, selected.address, selected.family);
	};
}
async function pinnedFetch(raw, options) {
	const url = new URL(raw);
	const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
	const transport = url.protocol === "https:" ? https : http;
	return new Promise((resolve, reject) => {
		const request = transport.request(url, {
			lookup: options.lookup,
			signal: options.signal,
			servername: net.isIP(hostname) ? void 0 : hostname
		}, (incoming) => {
			const headers = new Headers();
			for (const [name, value] of Object.entries(incoming.headers)) if (Array.isArray(value)) for (const item of value) headers.append(name, item);
			else if (value !== void 0) headers.set(name, value);
			const status = incoming.statusCode ?? 500;
			const body = status === 204 || status === 304 ? null : Readable.toWeb(incoming);
			const response = new Response(body, {
				status,
				headers
			});
			Object.defineProperty(response, "url", { value: url.href });
			resolve(response);
		});
		request.once("error", reject);
		request.end();
	});
}
async function cancelResponse(response) {
	try {
		await response.body?.cancel();
	} catch {}
}
async function readLimitedBody(response) {
	if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) {
		await cancelResponse(response);
		throw new Error("Image is empty or exceeds 20 MiB");
	}
	if (!response.body) throw new Error("Image is empty or exceeds 20 MiB");
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_IMAGE_BYTES) throw new Error("Image is empty or exceeds 20 MiB");
			chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
		}
	} catch (error) {
		try {
			await reader.cancel(error);
		} catch {}
		throw error;
	} finally {
		reader.releaseLock();
	}
	if (!total) throw new Error("Image is empty or exceeds 20 MiB");
	return Buffer.concat(chunks, total);
}
async function fetchRemoteImageBuffer(raw) {
	const { url, selected } = await validateRemoteImage(raw);
	const response = await (globalThis.fetch === systemFetch ? pinnedFetch : globalThis.fetch.bind(globalThis))(url.href, {
		signal: AbortSignal.timeout(15e3),
		redirect: "error",
		lookup: fixedLookup(selected)
	});
	if (response.url && response.url !== url.href) {
		try {
			await validateRemoteImage(response.url);
		} finally {
			await cancelResponse(response);
		}
		throw new Error("Image redirects are not allowed");
	}
	if (response.status >= 300 && response.status < 400) {
		await cancelResponse(response);
		throw new Error("Image redirects are not allowed");
	}
	if (!response.ok) {
		await cancelResponse(response);
		throw new Error(`Image download failed (${response.status})`);
	}
	return readLimitedBody(response);
}
async function uploadImageLark(params) {
	const response = await LarkClient.fromCfg(params.cfg, params.accountId).sdk.im.image.create({ data: {
		image_type: params.imageType,
		image: params.image
	} });
	const imageKey = response?.data?.image_key ?? response?.image_key;
	if (!imageKey) throw new Error("Feishu did not return an image_key");
	return { imageKey };
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/card/image-resolver.ts
const log$5 = larkLogger$1("card/image-resolver");
/** Matches complete markdown image syntax: `![alt](value)` */
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
var ImageResolver = class {
	/** URL → imageKey for successfully uploaded images. */
	resolved = /* @__PURE__ */ new Map();
	/** URL → upload Promise for in-flight uploads (dedup). */
	pending = /* @__PURE__ */ new Map();
	/** URLs that have already failed — skip retries. */
	failed = /* @__PURE__ */ new Set();
	cfg;
	accountId;
	onImageResolved;
	constructor(opts) {
		this.cfg = opts.cfg;
		this.accountId = opts.accountId;
		this.onImageResolved = opts.onImageResolved;
	}
	/**
	* Synchronously resolve image URLs in markdown text.
	*
	* - `img_xxx` references are kept as-is.
	* - URLs with a cached imageKey are replaced inline.
	* - URLs with an in-flight upload are stripped (will appear after re-flush).
	* - New URLs trigger an async upload and are stripped for now.
	*/
	resolveImages(text) {
		if (!text.includes("![")) return text;
		return text.replace(IMAGE_RE, (fullMatch, alt, value) => {
			if (value.startsWith("img_")) return fullMatch;
			if (!value.startsWith("http://") && !value.startsWith("https://")) return "";
			const cached = this.resolved.get(value);
			if (cached) return `![${alt}](${cached})`;
			if (this.failed.has(value)) return "";
			if (this.pending.has(value)) return "";
			this.startUpload(value);
			return "";
		});
	}
	/**
	* Resolve all image URLs in text synchronously: trigger uploads for new
	* URLs, wait for all pending uploads, then return text with image keys.
	*/
	async resolveImagesAwait(text, timeoutMs) {
		this.resolveImages(text);
		if (this.pending.size > 0) {
			log$5.info("resolveImagesAwait: waiting for uploads", {
				count: this.pending.size,
				timeoutMs
			});
			const allUploads = Promise.all(this.pending.values());
			const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs));
			await Promise.race([allUploads, timeout]);
			if (this.pending.size > 0) log$5.warn("resolveImagesAwait: timed out with pending uploads", { remaining: this.pending.size });
		}
		return this.resolveImages(text);
	}
	startUpload(url) {
		const uploadPromise = this.doUpload(url);
		this.pending.set(url, uploadPromise);
	}
	async doUpload(url) {
		try {
			log$5.info("uploading image", { url });
			const buffer = await fetchRemoteImageBuffer(url);
			const { imageKey } = await uploadImageLark({
				cfg: this.cfg,
				image: buffer,
				imageType: "message",
				accountId: this.accountId
			});
			log$5.info("image uploaded", {
				url,
				imageKey
			});
			this.resolved.set(url, imageKey);
			this.pending.delete(url);
			this.onImageResolved();
			return imageKey;
		} catch (err) {
			log$5.warn("image upload failed", {
				url,
				error: String(err)
			});
			this.pending.delete(url);
			this.failed.add(url);
			return null;
		}
	}
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/card/tool-use-trace-store.ts
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Runtime store for structured tool-use steps.
*
* The Feishu card renderer reads from this store by session key so it can
* render observable, replayable tool execution without relying purely on
* reply payload text.
*/
const TRACE_TTL_MS = 1800 * 1e3;
const MAX_SESSION_TRACES = 128;
const MAX_STEPS_PER_SESSION = 256;
const STEP_RUNNING_TIMEOUT_MS = 300 * 1e3;
const GENERIC_STRING_LIMIT = 512;
const RESULT_STRING_LIMIT = 1024;
const COMMAND_STRING_LIMIT = 4096;
const PATH_STRING_LIMIT = 2048;
const sessionTraces = /* @__PURE__ */ new Map();
function startToolUseTraceRun(sessionKey) {
	if (!sessionKey) return;
	pruneTraceStore();
	sessionTraces.set(sessionKey, {
		nextSeq: 1,
		updatedAt: Date.now(),
		steps: [],
		currentRunId: void 0
	});
}
function clearToolUseTraceRun(sessionKey) {
	if (!sessionKey) return;
	sessionTraces.delete(sessionKey);
}
function recordToolUseStart(params) {
	const { sessionKey, toolName, toolParams, toolCallId, runId } = params;
	if (!sessionKey || !toolName) return;
	const state = sessionTraces.get(sessionKey);
	if (!state) return;
	if (runId) {
		if (state.currentRunId === void 0) state.currentRunId = runId;
		else if (state.currentRunId !== runId) return;
	}
	const now = Date.now();
	if (state.steps.length >= MAX_STEPS_PER_SESSION) state.steps.splice(0, state.steps.length - MAX_STEPS_PER_SESSION + 1);
	state.steps.push({
		id: `${state.nextSeq}`,
		seq: state.nextSeq,
		toolName,
		toolCallId: toolCallId || void 0,
		runId: runId || void 0,
		params: sanitizeTraceValue(toolParams, 0, { source: "params" }),
		status: "running",
		startedAt: now
	});
	state.nextSeq += 1;
	state.updatedAt = now;
}
function recordToolUseEnd(params) {
	const { sessionKey, toolName, toolParams, toolCallId, runId, result, error, durationMs } = params;
	if (!sessionKey || !toolName) return;
	const state = sessionTraces.get(sessionKey);
	if (!state) return;
	if (runId && state.currentRunId !== void 0 && state.currentRunId !== runId) return;
	const now = Date.now();
	const sanitizedParams = sanitizeTraceValue(toolParams, 0, { source: "params" });
	const pendingIndex = findPendingStepIndex(state.steps, toolName, sanitizedParams, toolCallId);
	if (pendingIndex >= 0) {
		const step = state.steps[pendingIndex];
		if (!step) return;
		step.status = error ? "error" : "success";
		step.result = sanitizeTraceValue(result, 0, { source: "result" });
		step.error = error ? truncateText(error, 160) : void 0;
		step.durationMs = durationMs;
		step.finishedAt = now;
		if (!step.params && sanitizedParams) step.params = sanitizedParams;
		state.updatedAt = now;
		return;
	}
	state.steps.push({
		id: `${state.nextSeq}`,
		seq: state.nextSeq,
		toolName,
		toolCallId: toolCallId || void 0,
		runId: runId || void 0,
		params: sanitizedParams,
		result: sanitizeTraceValue(result, 0, { source: "result" }),
		error: error ? truncateText(error, 160) : void 0,
		durationMs,
		status: error ? "error" : "success",
		startedAt: now,
		finishedAt: now
	});
	state.nextSeq += 1;
	state.updatedAt = now;
}
function getToolUseTraceSteps(sessionKey) {
	if (!sessionKey) return [];
	const state = sessionTraces.get(sessionKey);
	if (!state) return [];
	if (Date.now() - state.updatedAt > TRACE_TTL_MS) {
		sessionTraces.delete(sessionKey);
		return [];
	}
	const now = Date.now();
	return state.steps.map((step) => {
		if (step.status === "running" && now - step.startedAt > STEP_RUNNING_TIMEOUT_MS) return {
			...step,
			status: "error",
			error: "timed out",
			finishedAt: now
		};
		return { ...step };
	});
}
function findPendingStepIndex(steps, toolName, params, toolCallId) {
	if (toolCallId) for (let index = steps.length - 1; index >= 0; index -= 1) {
		const step = steps[index];
		if (!step || step.status !== "running") continue;
		if (step.toolCallId === toolCallId) return index;
	}
	const normalizedToolName = normalizeToolName(toolName);
	const paramsKey = fingerprintTraceValue(params);
	for (let index = steps.length - 1; index >= 0; index -= 1) {
		const step = steps[index];
		if (!step || step.status !== "running") continue;
		if (normalizeToolName(step.toolName) !== normalizedToolName) continue;
		if (fingerprintTraceValue(step.params) !== paramsKey) continue;
		return index;
	}
	for (let index = steps.length - 1; index >= 0; index -= 1) {
		const step = steps[index];
		if (!step || step.status !== "running") continue;
		if (normalizeToolName(step.toolName) !== normalizedToolName) continue;
		return index;
	}
	return -1;
}
function pruneTraceStore() {
	const now = Date.now();
	for (const [sessionKey, state] of sessionTraces) if (now - state.updatedAt > TRACE_TTL_MS) sessionTraces.delete(sessionKey);
	if (sessionTraces.size <= MAX_SESSION_TRACES) return;
	const overflow = sessionTraces.size - MAX_SESSION_TRACES;
	const entries = [...sessionTraces.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
	for (const [sessionKey] of entries.slice(0, overflow)) sessionTraces.delete(sessionKey);
}
function sanitizeTraceValue(value, depth = 0, context = {}) {
	if (value == null) return void 0;
	if (typeof value === "string") {
		const limit = resolveStringLimit(context);
		return truncateText(sanitizeTraceString(value, context), limit);
	}
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (depth >= 2) return "[truncated]";
	if (Array.isArray(value)) return value.slice(0, 8).map((item) => sanitizeTraceValue(item, depth + 1, { source: context.source }));
	if (typeof value === "object") {
		const input = value;
		const output = {};
		for (const [key, entryValue] of Object.entries(input).slice(0, 12)) output[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeTraceValue(entryValue, depth + 1, {
			source: context.source,
			key
		});
		return output;
	}
	return truncateText(String(value), 180);
}
function sanitizeTraceString(value, context) {
	const redactedUrl = redactUrlParams(value);
	if (isCommandLikeKey(context.key)) return redactInlineSecrets(redactedUrl);
	return redactedUrl;
}
function resolveStringLimit(context) {
	const key = context.key?.toLowerCase() ?? "";
	if (/(?:^|_)(?:command|script|description|prompt|task)(?:$|_)/.test(key)) return COMMAND_STRING_LIMIT;
	if (/(?:^|_)(?:path|file|url|uri|cwd|folder|dir)(?:$|_)/.test(key)) return PATH_STRING_LIMIT;
	if (context.source === "result") return RESULT_STRING_LIMIT;
	return GENERIC_STRING_LIMIT;
}
function isCommandLikeKey(key) {
	const normalized = key?.toLowerCase() ?? "";
	return /(?:^|_)(?:command|script)(?:$|_)/.test(normalized);
}
const SENSITIVE_KEY_RE = /secret|token|password|authorization|cookie|api[-_]?key|credential|private[-_]?key|access[-_]?key|database[-_]?url|connection[-_]?string|bearer|signing[-_]?key|encryption[-_]?key|session[-_]?id|client[-_]?secret|auth[-_]?token/i;
function isSensitiveKey(key) {
	return SENSITIVE_KEY_RE.test(key);
}
function redactUrlParams(url) {
	return url.replace(/([?&])(api_key|token|secret|key)=[^&]*/gi, "$1$2=[redacted]");
}
function fingerprintTraceValue(value) {
	if (value == null) return "";
	if (typeof value !== "object") return String(value);
	return JSON.stringify(sortTraceValue(value));
}
function sortTraceValue(value) {
	if (Array.isArray(value)) return value.map((item) => sortTraceValue(item));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entryValue]) => [key, sortTraceValue(entryValue)]));
	return value;
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/card/unavailable-guard.ts
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Guard against operating on unavailable (deleted/recalled) messages.
*
* Encapsulates the terminateDueToUnavailable / shouldSkipForUnavailable
* logic previously scattered as closures in reply-dispatcher.ts.
*/
const log$4 = larkLogger$1("card/unavailable-guard");
var UnavailableGuard = class {
	terminated = false;
	replyToMessageId;
	getCardMessageId;
	onTerminate;
	constructor(params) {
		this.replyToMessageId = params.replyToMessageId;
		this.getCardMessageId = params.getCardMessageId;
		this.onTerminate = params.onTerminate;
	}
	get isTerminated() {
		return this.terminated;
	}
	/**
	* Check whether the reply pipeline should skip further operations.
	* Returns true if the message is already known to be unavailable.
	*/
	shouldSkip(source) {
		if (this.terminated) return true;
		if (!this.replyToMessageId) return false;
		if (!isMessageUnavailable(this.replyToMessageId)) return false;
		return this.terminate(source);
	}
	/**
	* Attempt to terminate the reply pipeline due to an unavailable message.
	*
	* @param source - Descriptive label for the caller (for logging).
	* @param err    - Optional error that triggered the check.
	* @returns true if the pipeline was (or already had been) terminated.
	*/
	terminate(source, err) {
		if (this.terminated) return true;
		const fromError = isMessageUnavailableError(err) ? err : void 0;
		const cardMessageId = this.getCardMessageId();
		const state = getMessageUnavailableState(this.replyToMessageId) ?? getMessageUnavailableState(cardMessageId ?? void 0);
		let apiCode = fromError?.apiCode ?? state?.apiCode;
		if (!apiCode && err) {
			const detectedCode = extractLarkApiCode(err);
			if (isTerminalMessageApiCode(detectedCode)) {
				const fallbackMessageId = this.replyToMessageId ?? cardMessageId ?? void 0;
				if (fallbackMessageId) markMessageUnavailable({
					messageId: fallbackMessageId,
					apiCode: detectedCode,
					operation: source
				});
				apiCode = detectedCode;
			}
		}
		if (!apiCode) return false;
		this.terminated = true;
		this.onTerminate();
		const affectedMessageId = fromError?.messageId ?? this.replyToMessageId ?? cardMessageId ?? "unknown";
		log$4.warn("reply pipeline terminated by unavailable message", {
			source,
			apiCode,
			messageId: affectedMessageId
		});
		return true;
	}
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/card/dsbot-streaming-card-controller.ts
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Streaming card controller for the Lark/Feishu channel plugin.
*
* Manages the full lifecycle of a streaming CardKit card:
* idle → creating → streaming → completed / aborted / terminated.
*
* Delegates throttling to FlushController and message-unavailable
* detection to UnavailableGuard.
*/
const log$3 = larkLogger$1("card/streaming");
var StreamingCardController = class {
	phase = "idle";
	cardKit = {
		cardKitCardId: null,
		originalCardKitCardId: null,
		cardKitSequence: 0,
		cardMessageId: null
	};
	text = {
		accumulatedText: "",
		completedText: "",
		streamingPrefix: "",
		lastPartialText: "",
		lastFlushedText: ""
	};
	reasoning = {
		accumulatedReasoningText: "",
		reasoningStartTime: null,
		reasoningElapsedMs: 0,
		isReasoningPhase: false
	};
	toolUse = {
		startedAt: null,
		elapsedMs: 0,
		isActive: false
	};
	flush;
	guard;
	imageResolver;
	createEpoch = 0;
	_terminalReason = null;
	dispatchFullyComplete = false;
	cardCreationPromise = null;
	disposeShutdownHook = null;
	dispatchStartTime = Date.now();
	deps;
	elapsed() {
		return Date.now() - this.dispatchStartTime;
	}
	/**
	* CardKit 终态整卡（2.0 结构）。宿主可通过 deps.terminalCardHooks.
	* transformTerminalCard 接管终态卡变换（DSH 用它把 markdown 管道表格换成
	* 飞书原生 table 组件）；未注入钩子时原样返回。流式阶段与 IM fallback
	* （1.0 结构）都不经过这里，保持 markdown 兼容。
	*/
	terminalCardKit2(card) {
		const kit = toCardKit2(card);
		const transform = this.deps.terminalCardHooks?.transformTerminalCard;
		return transform ? transform(kit) : kit;
	}
	/** 宿主注入了终态卡变换钩子 = 表格渲染由宿主接管，跳过内置代码块降级。 */
	hostOwnsTables() {
		return typeof this.deps.terminalCardHooks?.transformTerminalCard === "function";
	}
	needsFooterMetrics() {
		const footer = this.deps.resolvedFooter;
		return footer.tokens || footer.cache || footer.context || footer.model;
	}
	async getFooterSessionMetrics() {
		try {
			const runtime = LarkClient.runtime;
			if (!runtime) return void 0;
			const cfgWithSession = this.deps.cfg;
			const sessionStorePath = cfgWithSession.sessions?.store ?? cfgWithSession.session?.store;
			const key = this.deps.sessionKey.trim().toLowerCase();
			const defaultAgentId = resolveDefaultAgentId(this.deps.cfg);
			const fallbackKey = key.replace(/^(agent):[^:]+:/, `$1:${defaultAgentId}:`);
			const candidateKeys = fallbackKey !== key ? [key, fallbackKey] : [key];
			const sessionApi = runtime.agent?.session;
			if (sessionApi?.resolveStorePath && sessionApi?.loadSessionStore) {
				const storePath = sessionApi.resolveStorePath(sessionStorePath, { agentId: this.deps.agentId });
				const store = sessionApi.loadSessionStore(storePath);
				let entry;
				let matchedKey;
				for (const candidate of candidateKeys) {
					const val = store[candidate];
					if (val && typeof val === "object") {
						entry = val;
						matchedKey = candidate;
						break;
					}
				}
				if (!entry) {
					log$3.debug("footer metrics lookup: session entry missing", {
						sessionKey: this.deps.sessionKey,
						candidateKeys,
						storePath,
						source: "runtime.agent.session"
					});
					return;
				}
				const metrics = {
					inputTokens: typeof entry.inputTokens === "number" ? entry.inputTokens : void 0,
					outputTokens: typeof entry.outputTokens === "number" ? entry.outputTokens : void 0,
					cacheRead: typeof entry.cacheRead === "number" ? entry.cacheRead : void 0,
					cacheWrite: typeof entry.cacheWrite === "number" ? entry.cacheWrite : void 0,
					totalTokens: typeof entry.totalTokens === "number" ? entry.totalTokens : void 0,
					totalTokensFresh: typeof entry.totalTokensFresh === "boolean" ? entry.totalTokensFresh : void 0,
					contextTokens: typeof entry.contextTokens === "number" ? entry.contextTokens : void 0,
					model: typeof entry.model === "string" ? entry.model : void 0
				};
				log$3.debug("footer metrics lookup: session entry found", {
					sessionKey: this.deps.sessionKey,
					matchedKey,
					storePath,
					source: "runtime.agent.session"
				});
				return metrics;
			}
			const channelSession = runtime.channel?.session;
			if (!channelSession?.resolveStorePath) return;
			const storePath = channelSession.resolveStorePath(sessionStorePath, { agentId: this.deps.agentId });
			const raw = await readFile(storePath, "utf8");
			const parsed = JSON.parse(raw);
			const store = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
			let entry;
			let matchedKey;
			for (const candidate of candidateKeys) {
				const val = store[candidate];
				if (val && typeof val === "object") {
					entry = val;
					matchedKey = candidate;
					break;
				}
			}
			if (!entry) {
				log$3.debug("footer metrics lookup: session entry missing", {
					sessionKey: this.deps.sessionKey,
					candidateKeys,
					storePath,
					source: "channel.session.file"
				});
				return;
			}
			const metrics = {
				inputTokens: typeof entry.inputTokens === "number" ? entry.inputTokens : void 0,
				outputTokens: typeof entry.outputTokens === "number" ? entry.outputTokens : void 0,
				cacheRead: typeof entry.cacheRead === "number" ? entry.cacheRead : void 0,
				cacheWrite: typeof entry.cacheWrite === "number" ? entry.cacheWrite : void 0,
				totalTokens: typeof entry.totalTokens === "number" ? entry.totalTokens : void 0,
				totalTokensFresh: typeof entry.totalTokensFresh === "boolean" ? entry.totalTokensFresh : void 0,
				contextTokens: typeof entry.contextTokens === "number" ? entry.contextTokens : void 0,
				model: typeof entry.model === "string" ? entry.model : void 0
			};
			log$3.debug("footer metrics lookup: session entry found", {
				sessionKey: this.deps.sessionKey,
				matchedKey,
				storePath,
				source: "channel.session.file"
			});
			return metrics;
		} catch (err) {
			log$3.warn("footer metrics lookup failed", {
				error: String(err),
				sessionKey: this.deps.sessionKey
			});
			return;
		}
	}
	constructor(deps) {
		this.deps = deps;
		if (deps.notification?.state) {
			this.cardKit = {
				...deps.notification.state,
				originalCardKitCardId: deps.notification.state.cardKitCardId
			};
			if (this.cardKit.cardMessageId) this.phase = "streaming";
		}
		this.guard = new UnavailableGuard({
			replyToMessageId: deps.replyToMessageId,
			getCardMessageId: () => this.cardKit.cardMessageId,
			onTerminate: () => {
				this.transition("terminated", "UnavailableGuard", "unavailable");
			}
		});
		this.flush = new FlushController(() => this.performFlush());
		this.imageResolver = new ImageResolver({
			cfg: deps.cfg,
			accountId: deps.accountId,
			onImageResolved: () => {
				if (!this.isTerminalPhase && this.cardKit.cardMessageId) this.throttledCardUpdate();
			}
		});
	}
	get cardMessageId() {
		return this.cardKit.cardMessageId;
	}
	get isTerminalPhase() {
		return TERMINAL_PHASES.has(this.phase);
	}
	/**
	* Whether the card has been explicitly aborted (via abortCard()).
	*
	* Distinct from isTerminalPhase — creation_failed is NOT an abort;
	* it should allow fallthrough to static delivery in the factory.
	*/
	get isAborted() {
		return this.phase === "aborted";
	}
	/** Whether the reply pipeline was terminated due to an unavailable message. */
	get isTerminated() {
		return this.guard.isTerminated;
	}
	/** Check if the pipeline should skip further operations for this source. */
	shouldSkipForUnavailable(source) {
		return this.guard.shouldSkip(source);
	}
	/** Attempt to terminate the pipeline due to an unavailable message error. */
	terminateIfUnavailable(source, err) {
		return this.guard.terminate(source, err);
	}
	/** Why the controller entered a terminal phase, or null if still active. */
	get terminalReason() {
		return this._terminalReason;
	}
	/** @internal — exposed for test assertions only. */
	get currentPhase() {
		return this.phase;
	}
	get shouldDisplayToolUse() {
		return this.deps.toolUseDisplay.showToolUse;
	}
	computeToolUseDisplay() {
		if (!this.shouldDisplayToolUse) return null;
		return normalizeToolUseDisplay({
			traceSteps: getToolUseTraceSteps(this.deps.sessionKey),
			showFullPaths: this.deps.toolUseDisplay.showFullPaths,
			showResultDetails: this.deps.toolUseDisplay.showToolResultDetails
		});
	}
	get visibleToolUseElapsedMs() {
		if (!this.shouldDisplayToolUse || !this.toolUse.startedAt) return;
		return this.toolUse.elapsedMs || Date.now() - this.toolUse.startedAt;
	}
	computeToolUseTitleSuffix(display) {
		if (!this.shouldDisplayToolUse) return void 0;
		const stepCount = display?.stepCount ?? 0;
		return stepCount > 0 ? buildToolUseTitleSuffix({ stepCount }) : void 0;
	}
	/**
	* Unified callback guard — returns true if the pipeline is active
	* and the callback should proceed.
	*
	* Combines three checks:
	* 1. guard.isTerminated — message recalled/deleted
	* 2. guard.shouldSkip(source) — eagerly detect unavailable messages
	* 3. isTerminalPhase — completed/aborted/terminated/creation_failed
	*/
	shouldProceed(source) {
		if (this.guard.isTerminated || this.guard.shouldSkip(source)) return false;
		return !this.isTerminalPhase;
	}
	isStaleCreate(epoch) {
		return epoch !== this.createEpoch;
	}
	transition(to, source, reason) {
		const from = this.phase;
		if (from === to) return false;
		if (!PHASE_TRANSITIONS[from].has(to)) {
			log$3.warn("phase transition rejected", {
				from,
				to,
				source
			});
			return false;
		}
		this.phase = to;
		log$3.info("phase transition", {
			from,
			to,
			source,
			reason
		});
		if (TERMINAL_PHASES.has(to)) {
			this._terminalReason = reason ?? null;
			this.onEnterTerminalPhase();
		}
		return true;
	}
	onEnterTerminalPhase() {
		this.createEpoch += 1;
		this.flush.cancelPendingFlush();
		this.flush.complete();
		this.disposeShutdownHook?.();
		this.disposeShutdownHook = null;
		if (this.phase === "terminated" || this.phase === "creation_failed") clearToolUseTraceRun(this.deps.sessionKey);
	}
	markToolUseActivity() {
		if (!this.toolUse.startedAt) this.toolUse.startedAt = Date.now();
		this.toolUse.elapsedMs = Date.now() - this.toolUse.startedAt;
		this.toolUse.isActive = true;
	}
	captureToolUseElapsed() {
		if (!this.toolUse.startedAt) return;
		this.toolUse.elapsedMs = Date.now() - this.toolUse.startedAt;
		this.toolUse.isActive = false;
	}
	/**
	* Handle a deliver() call in streaming card mode.
	*
	* Accumulates text from the SDK's deliver callbacks to build the
	* authoritative "completedText" for the final card.
	*/
	async onDeliver(payload) {
		if (!this.shouldProceed("onDeliver")) return;
		const text = payload.text ?? "";
		if (!text.trim()) return;
		await this.ensureCardCreated();
		if (!this.shouldProceed("onDeliver.postCreate")) return;
		if (!this.cardKit.cardMessageId) return;
		this.captureToolUseElapsed();
		const split = splitReasoningText(text);
		if (split.reasoningText && !split.answerText) {
			this.reasoning.reasoningElapsedMs = this.reasoning.reasoningStartTime ? Date.now() - this.reasoning.reasoningStartTime : 0;
			this.reasoning.accumulatedReasoningText = split.reasoningText;
			this.reasoning.isReasoningPhase = true;
			await this.throttledCardUpdate();
			return;
		}
		this.reasoning.isReasoningPhase = false;
		if (split.reasoningText) this.reasoning.accumulatedReasoningText = split.reasoningText;
		const answerText = split.answerText ?? text;
		this.text.completedText += (this.text.completedText ? "\n\n" : "") + answerText;
		if (!this.text.lastPartialText && !this.text.streamingPrefix) {
			this.text.accumulatedText += (this.text.accumulatedText ? "\n\n" : "") + answerText;
			this.text.streamingPrefix = this.text.accumulatedText;
			await this.throttledCardUpdate();
		}
	}
	async onReasoningStream(payload) {
		if (!this.shouldProceed("onReasoningStream")) return;
		await this.ensureCardCreated();
		if (!this.shouldProceed("onReasoningStream.postCreate")) return;
		if (!this.cardKit.cardMessageId) return;
		const rawText = payload.text ?? "";
		if (!rawText) return;
		if (!this.reasoning.reasoningStartTime) this.reasoning.reasoningStartTime = Date.now();
		this.reasoning.isReasoningPhase = true;
		const split = splitReasoningText(rawText);
		this.reasoning.accumulatedReasoningText = split.reasoningText ?? rawText;
		await this.throttledCardUpdate();
	}
	async onToolStart(payload) {
		if (!this.shouldProceed("onToolStart")) return;
		if (!this.shouldDisplayToolUse) return;
		if (payload.phase && payload.phase !== "start") return;
		this.markToolUseActivity();
		await this.ensureCardCreated();
		if (!this.shouldProceed("onToolStart.postCreate")) return;
		if (!this.cardKit.cardMessageId) return;
		if (this.cardKit.cardKitCardId) {
			await this.throttledToolUseStatusUpdate();
			return;
		}
		await this.throttledCardUpdate();
	}
	async onToolPayload(_payload) {
		if (!this.shouldProceed("onToolPayload")) return;
		if (!this.shouldDisplayToolUse) return;
		this.markToolUseActivity();
		await this.ensureCardCreated();
		if (!this.shouldProceed("onToolPayload.postCreate")) return;
		if (!this.cardKit.cardMessageId) return;
		if (this.cardKit.cardKitCardId) {
			await this.throttledToolUseStatusUpdate();
			return;
		}
		await this.throttledCardUpdate();
	}
	async onPartialReply(payload) {
		if (!this.shouldProceed("onPartialReply")) return;
		const rawText = payload.text ?? "";
		const split = splitReasoningText(rawText);
		if (split.reasoningText) {
			if (!this.reasoning.reasoningStartTime) this.reasoning.reasoningStartTime = Date.now();
			this.reasoning.accumulatedReasoningText = split.reasoningText;
			this.reasoning.isReasoningPhase = true;
		}
		const text = split.answerText ?? stripReasoningTags(rawText);
		log$3.debug("onPartialReply", { len: text.length });
		if (!text) return;
		this.captureToolUseElapsed();
		if (!this.reasoning.reasoningStartTime) this.reasoning.reasoningStartTime = Date.now();
		if (this.reasoning.isReasoningPhase) {
			this.reasoning.isReasoningPhase = false;
			this.reasoning.reasoningElapsedMs = this.reasoning.reasoningStartTime ? Date.now() - this.reasoning.reasoningStartTime : 0;
		}
		if (this.text.lastPartialText && text.length < this.text.lastPartialText.length) this.text.streamingPrefix += (this.text.streamingPrefix ? "\n\n" : "") + this.text.lastPartialText;
		this.text.lastPartialText = text;
		this.text.accumulatedText = this.text.streamingPrefix ? this.text.streamingPrefix + "\n\n" + text : text;
		if (!this.text.streamingPrefix && "NO_REPLY".startsWith(this.text.accumulatedText.trim())) {
			log$3.debug("onPartialReply: buffering NO_REPLY prefix");
			return;
		}
		await this.ensureCardCreated();
		if (!this.shouldProceed("onPartialReply.postCreate")) return;
		if (!this.cardKit.cardMessageId) return;
		await this.throttledCardUpdate();
	}
	async onError(err, info) {
		if (this.isTerminalPhase) {
			await this.retryTerminal();
			return;
		}
		if (this.guard.terminate("onError", err)) return;
		log$3.error(`${info.kind} reply failed`, { error: String(err) });
		this.captureToolUseElapsed();
		this.finalizeCard("onError", "error");
		await this.flush.waitForFlush();
		if (this.cardCreationPromise) await this.cardCreationPromise;
		const errorEffectiveCardId = this.cardKit.cardKitCardId ?? this.cardKit.originalCardKitCardId;
		const footerMetrics = this.needsFooterMetrics() ? await this.getFooterSessionMetrics() : void 0;
		const toolUseDisplay = this.computeToolUseDisplay();
		try {
			if (this.cardKit.cardMessageId) {
				const terminalContent = prepareTerminalCardContent({
					text: this.text.accumulatedText ? `${this.text.accumulatedText}\n\n---\n**Error**: An error occurred while generating the response.` : "**Error**: An error occurred while generating the response.",
					reasoningText: this.reasoning.accumulatedReasoningText || void 0
				}, this.imageResolver, 3, this.hostOwnsTables());
				const errorCard = buildCardContent("complete", {
					text: terminalContent.text,
					reasoningText: terminalContent.reasoningText,
					reasoningElapsedMs: this.reasoning.reasoningElapsedMs || void 0,
					toolUseSteps: toolUseDisplay?.steps,
					toolUseTitleSuffix: this.computeToolUseTitleSuffix(toolUseDisplay),
					toolUseElapsedMs: this.visibleToolUseElapsedMs,
					showToolUse: this.deps.toolUseDisplay.showToolUse,
					elapsedMs: this.elapsed(),
					isError: true,
					footer: this.deps.resolvedFooter,
					footerMetrics
				});
				if (errorEffectiveCardId) await this.closeStreamingAndUpdate(errorEffectiveCardId, errorCard, "onError");
				else await updateCardFeishu({
					cfg: this.deps.cfg,
					messageId: this.cardKit.cardMessageId,
					card: errorCard,
					accountId: this.deps.accountId
				});
			}
		} catch (error) {
			if (this.deps.notification) throw error;
		}
		clearToolUseTraceRun(this.deps.sessionKey);
	}
	async onIdle() {
		if (this.guard.isTerminated || this.guard.shouldSkip("onIdle")) return;
		if (!this.dispatchFullyComplete) return;
		if (this.isTerminalPhase) {
			await this.retryTerminal();
			return;
		}
		this.captureToolUseElapsed();
		this.finalizeCard("onIdle", "normal");
		await this.flush.waitForFlush();
		if (this.cardCreationPromise) {
			await this.cardCreationPromise;
			await new Promise((resolve) => setTimeout(resolve, 0));
			await this.flush.waitForFlush();
		}
		const idleEffectiveCardId = this.cardKit.cardKitCardId ?? this.cardKit.originalCardKitCardId;
		try {
			if (this.cardKit.cardMessageId) {
				if (idleEffectiveCardId) {
					const seqBeforeClose = this.cardKit.cardKitSequence;
					this.cardKit.cardKitSequence += 1;
					log$3.info("onIdle: closing streaming mode", {
						seqBefore: seqBeforeClose,
						seqAfter: this.cardKit.cardKitSequence
					});
					this.checkpointNotification();
					await setCardStreamingMode({
						cfg: this.deps.cfg,
						cardId: idleEffectiveCardId,
						streamingMode: false,
						sequence: this.cardKit.cardKitSequence,
						accountId: this.deps.accountId
					});
				}
				const isNoReplyLeak = !this.text.completedText && "NO_REPLY".startsWith(this.text.accumulatedText.trim());
				const displayText = this.text.completedText || (isNoReplyLeak ? "" : this.text.accumulatedText) || "Done.";
				if (!this.text.completedText && !this.text.accumulatedText) log$3.warn("reply completed without visible text, using empty-reply fallback");
				const resolvedDisplayText = await this.imageResolver.resolveImagesAwait(displayText, 15e3);
				const idleToolUseDisplay = this.computeToolUseDisplay();
				const terminalContent = prepareTerminalCardContent({
					text: resolvedDisplayText,
					reasoningText: this.reasoning.accumulatedReasoningText || void 0
				}, this.imageResolver, 3, this.hostOwnsTables());
				const footerMetrics = this.needsFooterMetrics() ? await this.getFooterSessionMetrics() : void 0;
				const completeCard = buildCardContent("complete", {
					text: terminalContent.text,
					reasoningText: terminalContent.reasoningText,
					reasoningElapsedMs: this.reasoning.reasoningElapsedMs || void 0,
					toolUseSteps: idleToolUseDisplay?.steps,
					toolUseTitleSuffix: this.computeToolUseTitleSuffix(idleToolUseDisplay),
					toolUseElapsedMs: this.visibleToolUseElapsedMs,
					showToolUse: this.deps.toolUseDisplay.showToolUse,
					elapsedMs: this.elapsed(),
					footer: this.deps.resolvedFooter,
					footerMetrics
				});
				if (idleEffectiveCardId) {
					const seqBeforeUpdate = this.cardKit.cardKitSequence;
					this.cardKit.cardKitSequence += 1;
					log$3.info("onIdle: updating final card", {
						seqBefore: seqBeforeUpdate,
						seqAfter: this.cardKit.cardKitSequence
					});
					this.checkpointNotification();
					await updateCardKitCard({
						cfg: this.deps.cfg,
						cardId: idleEffectiveCardId,
						card: this.terminalCardKit2(completeCard),
						sequence: this.cardKit.cardKitSequence,
						accountId: this.deps.accountId
					});
				} else await updateCardFeishu({
					cfg: this.deps.cfg,
					messageId: this.cardKit.cardMessageId,
					card: completeCard,
					accountId: this.deps.accountId
				});
				log$3.info("reply completed, card finalized", {
					elapsedMs: this.elapsed(),
					isCardKit: !!idleEffectiveCardId
				});
			}
		} catch (err) {
			log$3.warn("final card update failed", { error: String(err) });
			if (this.deps.notification) throw err;
		}
		if (this.phase === "completed") clearToolUseTraceRun(this.deps.sessionKey);
	}
	markFullyComplete() {
		log$3.debug("markFullyComplete", {
			completedTextLen: this.text.completedText.length,
			accumulatedTextLen: this.text.accumulatedText.length
		});
		this.dispatchFullyComplete = true;
	}
	async abortCard() {
		if (this.isTerminalPhase) {
			await this.retryTerminal();
			return;
		}
		try {
			this.captureToolUseElapsed();
			if (!this.transition("aborted", "abortCard", "abort")) return;
			await this.flush.waitForFlush();
			if (this.cardCreationPromise) await this.cardCreationPromise;
			const effectiveCardId = this.cardKit.cardKitCardId ?? this.cardKit.originalCardKitCardId;
			const elapsedMs = Date.now() - this.dispatchStartTime;
			const abortToolUseDisplay = this.computeToolUseDisplay();
			const terminalContent = prepareTerminalCardContent({
				text: this.text.accumulatedText || "Aborted.",
				reasoningText: this.reasoning.accumulatedReasoningText || void 0
			}, this.imageResolver, 3, this.hostOwnsTables());
			const footerMetrics = this.needsFooterMetrics() ? await this.getFooterSessionMetrics() : void 0;
			if (effectiveCardId) {
				const abortCardContent = buildCardContent("complete", {
					text: terminalContent.text,
					reasoningText: terminalContent.reasoningText,
					reasoningElapsedMs: this.reasoning.reasoningElapsedMs || void 0,
					toolUseSteps: abortToolUseDisplay?.steps,
					toolUseTitleSuffix: this.computeToolUseTitleSuffix(abortToolUseDisplay),
					toolUseElapsedMs: this.visibleToolUseElapsedMs,
					showToolUse: this.deps.toolUseDisplay.showToolUse,
					elapsedMs,
					isAborted: true,
					footer: this.deps.resolvedFooter,
					footerMetrics
				});
				await this.closeStreamingAndUpdate(effectiveCardId, abortCardContent, "abortCard");
				log$3.info("abortCard completed", { effectiveCardId });
			} else if (this.cardKit.cardMessageId) {
				const abortCard = buildCardContent("complete", {
					text: terminalContent.text,
					reasoningText: terminalContent.reasoningText,
					reasoningElapsedMs: this.reasoning.reasoningElapsedMs || void 0,
					toolUseSteps: abortToolUseDisplay?.steps,
					toolUseTitleSuffix: this.computeToolUseTitleSuffix(abortToolUseDisplay),
					toolUseElapsedMs: this.visibleToolUseElapsedMs,
					showToolUse: this.deps.toolUseDisplay.showToolUse,
					elapsedMs,
					isAborted: true,
					footer: this.deps.resolvedFooter,
					footerMetrics
				});
				await updateCardFeishu({
					cfg: this.deps.cfg,
					messageId: this.cardKit.cardMessageId,
					card: abortCard,
					accountId: this.deps.accountId
				});
				log$3.info("abortCard completed (IM fallback)", { messageId: this.cardKit.cardMessageId });
			}
		} catch (err) {
			log$3.warn("abortCard failed", { error: String(err) });
			if (this.deps.notification) throw err;
		}
		clearToolUseTraceRun(this.deps.sessionKey);
	}
	checkpointNotification() {
		this.deps.notification?.checkpoint({
			cardMessageId: this.cardKit.cardMessageId,
			cardKitCardId: this.cardKit.cardKitCardId ?? this.cardKit.originalCardKitCardId,
			cardKitSequence: this.cardKit.cardKitSequence
		});
	}
	async ensureCardCreated() {
		if (this.guard.shouldSkip("ensureCardCreated.precheck")) return;
		if (this.cardKit.cardMessageId || this.phase === "creation_failed" || this.isTerminalPhase) return;
		if (this.cardCreationPromise) {
			await this.cardCreationPromise;
			return;
		}
		if (this.phase !== "creating" && !this.transition("creating", "ensureCardCreated")) return;
		this.createEpoch += 1;
		const epoch = this.createEpoch;
		const creation = (async () => {
			let cId = this.cardKit.cardKitCardId;
			try {
				try {
					cId = cId ?? await createCardEntity({
						cfg: this.deps.cfg,
						card: buildStreamingThinkingCard(this.deps.toolUseDisplay.showToolUse),
						accountId: this.deps.accountId
					});
					if (this.isStaleCreate(epoch)) {
						log$3.info("ensureCardCreated: stale epoch after createCardEntity, bailing out", {
							epoch,
							phase: this.phase
						});
						return;
					}
					if (cId) {
						this.cardKit.cardKitCardId = cId;
						this.cardKit.originalCardKitCardId = cId;
						this.cardKit.cardKitSequence = Math.max(1, this.cardKit.cardKitSequence);
						this.checkpointNotification();
						this.disposeShutdownHook = registerShutdownHook(`streaming-card:${cId}`, () => this.abortCard());
						log$3.info("created CardKit entity", {
							cardId: cId,
							initialSequence: this.cardKit.cardKitSequence
						});
						const result = await sendCardByCardId({
							cfg: this.deps.cfg,
							to: this.deps.chatId,
							cardId: cId,
							...this.deps.notification ? { uuid: this.deps.notification.uuid } : {},
							replyToMessageId: this.deps.replyToMessageId,
							replyInThread: this.deps.replyInThread,
							accountId: this.deps.accountId
						});
						if (this.isStaleCreate(epoch)) {
							log$3.info("ensureCardCreated: stale epoch after sendCardByCardId, bailing out", {
								epoch,
								phase: this.phase
							});
							this.disposeShutdownHook?.();
							this.disposeShutdownHook = null;
							return;
						}
						this.cardKit.cardMessageId = result.messageId;
						this.checkpointNotification();
						this.flush.setCardMessageReady(true);
						if (!this.transition("streaming", "ensureCardCreated.cardkit")) {
							this.disposeShutdownHook?.();
							this.disposeShutdownHook = null;
							return;
						}
						log$3.info("sent CardKit card", { messageId: result.messageId });
					} else throw new Error("card.create returned empty card_id");
				} catch (cardKitErr) {
					if (this.isStaleCreate(epoch)) return;
					if (this.guard.terminate("ensureCardCreated.cardkitFlow", cardKitErr)) return;
					if (this.deps.notification) {
						if (!cId && !this.cardKit.cardKitCardId) {
							this.transition("creation_failed", "ensureCardCreated.cardkitFlow", "creation_failed");
							return;
						}
						throw cardKitErr;
					}
					const apiDetail = extractApiDetail(cardKitErr);
					log$3.warn("CardKit flow failed, falling back to IM", { apiDetail });
					this.cardKit.cardKitCardId = null;
					this.cardKit.originalCardKitCardId = null;
					const fallbackCard = buildCardContent("streaming", { showToolUse: this.deps.toolUseDisplay.showToolUse });
					const result = await sendCardFeishu({
						cfg: this.deps.cfg,
						to: this.deps.chatId,
						card: fallbackCard,
						replyToMessageId: this.deps.replyToMessageId,
						replyInThread: this.deps.replyInThread,
						accountId: this.deps.accountId
					});
					if (this.isStaleCreate(epoch)) {
						log$3.info("ensureCardCreated: stale epoch after IM fallback send, bailing out", {
							epoch,
							phase: this.phase
						});
						return;
					}
					this.cardKit.cardMessageId = result.messageId;
					this.flush.setCardMessageReady(true);
					if (!this.transition("streaming", "ensureCardCreated.imFallback")) return;
					log$3.info("sent fallback IM card", { messageId: result.messageId });
				}
			} catch (err) {
				if (this.deps.notification) throw err;
				if (this.isStaleCreate(epoch)) return;
				if (this.guard.terminate("ensureCardCreated.outer", err)) return;
				log$3.warn("thinking card failed, falling back to static", { error: String(err) });
				this.transition("creation_failed", "ensureCardCreated.outer", "creation_failed");
			}
		})();
		this.cardCreationPromise = creation;
		try {
			await creation;
		} finally {
			if (this.cardCreationPromise === creation) this.cardCreationPromise = null;
		}
	}
	async performFlush() {
		if (!this.cardKit.cardMessageId || this.isTerminalPhase) return;
		if (!this.cardKit.cardKitCardId && this.cardKit.originalCardKitCardId) {
			log$3.debug("performFlush: skipping (CardKit streaming disabled, awaiting final update)");
			return;
		}
		log$3.debug("flushCardUpdate: enter", {
			seq: this.cardKit.cardKitSequence,
			isCardKit: !!this.cardKit.cardKitCardId
		});
		try {
			const displayText = this.buildDisplayText();
			const resolvedText = this.imageResolver.resolveImages(displayText);
			if (this.cardKit.cardKitCardId) {
				if (resolvedText !== this.text.lastFlushedText) {
					const prevSeq = this.cardKit.cardKitSequence;
					this.cardKit.cardKitSequence += 1;
					log$3.debug("flushCardUpdate: answer seq bump", {
						seqBefore: prevSeq,
						seqAfter: this.cardKit.cardKitSequence
					});
					await streamCardContent({
						cfg: this.deps.cfg,
						cardId: this.cardKit.cardKitCardId,
						elementId: STREAMING_ELEMENT_ID,
						content: optimizeMarkdownStyle(resolvedText),
						sequence: this.cardKit.cardKitSequence,
						accountId: this.deps.accountId
					});
					this.text.lastFlushedText = resolvedText;
				}
			} else {
				log$3.debug("flushCardUpdate: IM patch fallback");
				const flushDisplay = this.computeToolUseDisplay();
				const card = buildCardContent("streaming", {
					text: this.reasoning.isReasoningPhase ? "" : resolvedText,
					reasoningText: this.reasoning.isReasoningPhase ? this.reasoning.accumulatedReasoningText : void 0,
					toolUseSteps: flushDisplay?.steps,
					toolUseTitleSuffix: this.computeToolUseTitleSuffix(flushDisplay),
					showToolUse: this.deps.toolUseDisplay.showToolUse
				});
				await updateCardFeishu({
					cfg: this.deps.cfg,
					messageId: this.cardKit.cardMessageId,
					card,
					accountId: this.deps.accountId
				});
			}
		} catch (err) {
			if (this.guard.terminate("flushCardUpdate", err)) return;
			const apiCode = extractLarkApiCode(err);
			if (isCardRateLimitError(err)) {
				log$3.info("flushCardUpdate: rate limited (230020), skipping", { seq: this.cardKit.cardKitSequence });
				return;
			}
			if (isCardTableLimitError(err)) {
				log$3.warn("flushCardUpdate: card table limit exceeded (230099/11310), disabling CardKit streaming", { seq: this.cardKit.cardKitSequence });
				this.cardKit.cardKitCardId = null;
				return;
			}
			const apiDetail = extractApiDetail(err);
			log$3.error("card stream update failed", {
				apiCode,
				seq: this.cardKit.cardKitSequence,
				apiDetail
			});
			if (this.cardKit.cardKitCardId) {
				log$3.warn("disabling CardKit streaming, falling back to im.message.patch");
				this.cardKit.cardKitCardId = null;
			}
		}
	}
	buildDisplayText() {
		if (this.reasoning.isReasoningPhase && this.reasoning.accumulatedReasoningText) {
			const reasoningDisplay = `💭 **Thinking...**\n\n${this.reasoning.accumulatedReasoningText}`;
			return this.text.accumulatedText ? this.text.accumulatedText + "\n\n" + reasoningDisplay : reasoningDisplay;
		}
		return this.text.accumulatedText;
	}
	async throttledCardUpdate() {
		if (this.guard.shouldSkip("throttledCardUpdate")) return;
		const throttleMs = this.cardKit.cardKitCardId ? THROTTLE_CONSTANTS.CARDKIT_MS : THROTTLE_CONSTANTS.PATCH_MS;
		await this.flush.throttledUpdate(throttleMs);
	}
	lastToolUseStatusUpdateTime = 0;
	async throttledToolUseStatusUpdate() {
		if (!this.cardKit.cardKitCardId) return;
		const elapsed = Date.now() - this.lastToolUseStatusUpdateTime;
		if (elapsed < THROTTLE_CONSTANTS.REASONING_STATUS_MS) await new Promise((resolve) => setTimeout(resolve, THROTTLE_CONSTANTS.REASONING_STATUS_MS - elapsed));
		this.lastToolUseStatusUpdateTime = Date.now();
		await this.updateToolUseStatus();
	}
	async updateToolUseStatus() {
		if (!this.cardKit.cardKitCardId || this.isTerminalPhase) return;
		try {
			const display = this.computeToolUseDisplay();
			const resolvedText = this.imageResolver.resolveImages(this.buildDisplayText());
			const card = buildStreamingPreAnswerCard({
				steps: display?.steps,
				elapsedMs: this.visibleToolUseElapsedMs,
				showToolUse: this.shouldDisplayToolUse,
				text: optimizeMarkdownStyle(resolvedText)
			});
			this.cardKit.cardKitSequence += 1;
			await updateCardKitCard({
				cfg: this.deps.cfg,
				cardId: this.cardKit.cardKitCardId,
				card,
				sequence: this.cardKit.cardKitSequence,
				accountId: this.deps.accountId
			});
		} catch (err) {
			log$3.debug("updateToolUseStatus failed", { error: String(err) });
		}
	}
	finalizeCard(source, reason) {
		this.transition("completed", source, reason);
	}
	/** Retry the last terminal write without creating a new card or replaying text. */
	async retryTerminal() {
		const cardId = this.cardKit.cardKitCardId ?? this.cardKit.originalCardKitCardId;
		const isError = this._terminalReason === "error";
		const isAborted = this._terminalReason === "abort";
		const terminalContent = prepareTerminalCardContent({
			text: this.text.completedText || this.text.accumulatedText || (isError ? "**Error**: An error occurred while generating the response." : isAborted ? "Aborted." : "Done."),
			reasoningText: this.reasoning.accumulatedReasoningText || void 0
		}, this.imageResolver, 3, this.hostOwnsTables());
		const toolUseDisplay = this.computeToolUseDisplay();
		const card = buildCardContent("complete", {
			text: terminalContent.text,
			reasoningText: terminalContent.reasoningText,
			reasoningElapsedMs: this.reasoning.reasoningElapsedMs || void 0,
			toolUseSteps: toolUseDisplay?.steps,
			toolUseTitleSuffix: this.computeToolUseTitleSuffix(toolUseDisplay),
			toolUseElapsedMs: this.visibleToolUseElapsedMs,
			showToolUse: this.deps.toolUseDisplay.showToolUse,
			elapsedMs: this.elapsed(),
			isError,
			isAborted,
			footer: this.deps.resolvedFooter
		});
		if (cardId) {
			this.cardKit.cardKitSequence += 1;
			this.checkpointNotification();
			await setCardStreamingMode({
				cfg: this.deps.cfg,
				cardId,
				streamingMode: false,
				sequence: this.cardKit.cardKitSequence,
				accountId: this.deps.accountId
			});
			this.checkpointNotification();
			this.cardKit.cardKitSequence += 1;
			this.checkpointNotification();
			await updateCardKitCard({
				cfg: this.deps.cfg,
				cardId,
				card: this.terminalCardKit2(card),
				sequence: this.cardKit.cardKitSequence,
				accountId: this.deps.accountId
			});
			this.checkpointNotification();
		} else if (this.cardKit.cardMessageId) await updateCardFeishu({
			cfg: this.deps.cfg,
			messageId: this.cardKit.cardMessageId,
			card,
			accountId: this.deps.accountId
		});
		clearToolUseTraceRun(this.deps.sessionKey);
	}
	/**
	* Close streaming mode then update card content (shared by onError and abortCard).
	*/
	async closeStreamingAndUpdate(cardId, card, label) {
		const seqBeforeClose = this.cardKit.cardKitSequence;
		this.cardKit.cardKitSequence += 1;
		log$3.info(`${label}: closing streaming mode`, {
			seqBefore: seqBeforeClose,
			seqAfter: this.cardKit.cardKitSequence
		});
		await setCardStreamingMode({
			cfg: this.deps.cfg,
			cardId,
			streamingMode: false,
			sequence: this.cardKit.cardKitSequence,
			accountId: this.deps.accountId
		});
		this.checkpointNotification();
		const seqBeforeUpdate = this.cardKit.cardKitSequence;
		this.cardKit.cardKitSequence += 1;
		log$3.info(`${label}: updating card`, {
			seqBefore: seqBeforeUpdate,
			seqAfter: this.cardKit.cardKitSequence
		});
		await updateCardKitCard({
			cfg: this.deps.cfg,
			cardId,
			card: this.terminalCardKit2(card),
			sequence: this.cardKit.cardKitSequence,
			accountId: this.deps.accountId
		});
		this.checkpointNotification();
	}
};
/**
* 终态卡片的正文和 reasoning 都会被飞书按 markdown 渲染，
* 因此两者都要先做图片替换与表格降级，避免再次撞到 230099/11310。
*
* hostOwnsTables 例外：宿主注入了终态卡变换钩子（terminalCardHooks.
* transformTerminalCard）时不做代码块降级——表格渲染由宿主接管（DSH 的
* 原生 table 转换统一按 maxTables 转成原生组件 / 可读列表，代码块会让
* 第 4 张起永远停留在竖线原文，正是要修掉的生硬降级）。
*/
function prepareTerminalCardContent(content, imageResolver, tableLimit = 3, hostOwnsTables = false) {
	const resolvedReasoningText = content.reasoningText ? imageResolver.resolveImages(content.reasoningText) : void 0;
	const resolvedText = imageResolver.resolveImages(content.text);
	if (hostOwnsTables) return resolvedReasoningText ? {
		reasoningText: resolvedReasoningText,
		text: resolvedText
	} : { text: resolvedText };
	const sanitizedSegments = sanitizeTextSegmentsForCard(resolvedReasoningText ? [resolvedReasoningText, resolvedText] : [resolvedText], tableLimit);
	if (resolvedReasoningText) return {
		reasoningText: sanitizedSegments[0],
		text: sanitizedSegments[1]
	};
	return { text: sanitizedSegments[0] };
}
function extractApiDetail(err) {
	if (!err || typeof err !== "object") return String(err);
	const e = err;
	return e.response?.data ? JSON.stringify(e.response.data) : String(err);
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/dist/core/lark-ticket.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Request-level ticket for the Feishu plugin.
*
* Uses Node.js AsyncLocalStorage to propagate a ticket (message_id,
* chat_id, account_id) through the entire async call chain without passing
* parameters explicitly.  Call {@link withTicket} at the event entry point
* (monitor.ts) and use {@link getTicket} anywhere downstream.
*/
const store = new AsyncLocalStorage();
/** Return the current ticket, or `undefined` if not inside withTicket. */
function getTicket() {
	return store.getStore();
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/dist/core/runtime-store.js
let runtime = null;
function tryGetLarkRuntime() {
	return runtime;
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/dist/core/lark-logger.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Structured logger factory for the Feishu plugin.
*
* Wraps `PluginRuntime.logging.getChildLogger()` with automatic
* LarkTicket injection from AsyncLocalStorage and a console fallback
* when the runtime is not yet initialised.
*
* Usage:
*   const log = larkLogger("card/streaming");
*   log.info("created entity", { cardId, sequence });
*/
const CYAN = "\x1B[36m";
const YELLOW = "\x1B[33m";
const RED = "\x1B[31m";
const GRAY = "\x1B[90m";
const RESET = "\x1B[0m";
function consoleFallback(subsystem) {
	const tag = `feishu/${subsystem}`;
	return {
		debug: (msg, meta) => console.debug(`${GRAY}[${tag}]${RESET}`, msg, ...meta ? [meta] : []),
		info: (msg, meta) => console.log(`${CYAN}[${tag}]${RESET}`, msg, ...meta ? [meta] : []),
		warn: (msg, meta) => console.warn(`${YELLOW}[${tag}]${RESET}`, msg, ...meta ? [meta] : []),
		error: (msg, meta) => console.error(`${RED}[${tag}]${RESET}`, msg, ...meta ? [meta] : [])
	};
}
function resolveRuntimeLogger(subsystem) {
	try {
		const runtime = tryGetLarkRuntime();
		if (!runtime) return null;
		return runtime.logging.getChildLogger({ subsystem: `feishu/${subsystem}` });
	} catch {
		return null;
	}
}
function getTraceMeta() {
	const ctx = getTicket();
	if (!ctx) return null;
	const trace = {
		accountId: ctx.accountId,
		messageId: ctx.messageId,
		chatId: ctx.chatId
	};
	if (ctx.senderOpenId) trace.senderOpenId = ctx.senderOpenId;
	return trace;
}
function enrichMeta(meta) {
	const trace = getTraceMeta();
	if (!trace) return meta ?? {};
	return meta ? {
		...trace,
		...meta
	} : trace;
}
/**
* Build a trace-aware prefix like `feishu[default][msg:om_xxx]:`.
*
* Mirrors the format used by `trace.ts` so log lines are consistent
* across the old and new logging systems.
*/
function buildTracePrefix() {
	const ctx = getTicket();
	if (!ctx) return "feishu:";
	return `feishu[${ctx.accountId}][msg:${ctx.messageId}]:`;
}
/**
* Format message with inline meta for text-based log output.
*
* RuntimeLogger implementations typically ignore the `meta` parameter in
* their text output (gateway.log / console).  To ensure meta is always
* visible, we serialize user-supplied meta into the message string and
* prepend the trace context prefix (accountId + messageId).
*
* Example:
*   formatMessage("card.create response", { code: 0, cardId: "c_xxx" })
*   → "feishu[default][msg:om_xxx]: card.create response (code=0, cardId=c_xxx)"
*/
function formatMessage(message, meta) {
	const prefix = buildTracePrefix();
	if (!meta || Object.keys(meta).length === 0) return `${prefix} ${message}`;
	const parts = Object.entries(meta).map(([k, v]) => {
		if (v === void 0 || v == null) return null;
		if (typeof v === "object") return `${k}=${JSON.stringify(v)}`;
		return `${k}=${v}`;
	}).filter(Boolean);
	return parts.length > 0 ? `${prefix} ${message} (${parts.join(", ")})` : `${prefix} ${message}`;
}
function createLarkLogger(subsystem) {
	let cachedLogger = null;
	let resolved = false;
	function getLogger() {
		if (!resolved) {
			cachedLogger = resolveRuntimeLogger(subsystem);
			if (cachedLogger) resolved = true;
		}
		return cachedLogger ?? consoleFallback(subsystem);
	}
	return {
		subsystem,
		debug(message, meta) {
			getLogger().debug?.(formatMessage(message, meta), enrichMeta(meta));
		},
		info(message, meta) {
			getLogger().info(formatMessage(message, meta), enrichMeta(meta));
		},
		warn(message, meta) {
			getLogger().warn(formatMessage(message, meta), enrichMeta(meta));
		},
		error(message, meta) {
			getLogger().error(formatMessage(message, meta), enrichMeta(meta));
		},
		child(name) {
			return createLarkLogger(`${subsystem}/${name}`);
		}
	};
}
function larkLogger(subsystem) {
	return createLarkLogger(subsystem);
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/dist/core/auth-errors.js
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* auth-errors.ts — 统一错误类型定义。
*
* 所有与认证/授权/scope 相关的错误类型集中在此文件，
* 解除 tool-client ↔ app-scope-checker 循环依赖。
*
* 其他模块应直接 import 此文件，或通过 tool-client / uat-client 的 re-export 使用。
*/
/** 飞书 OAPI 错误码常量，替代各处硬编码的 magic number。 */
const LARK_ERROR = {
	/** 应用 scope 不足（租户维度） */
	APP_SCOPE_MISSING: 99991672,
	/** 用户 token scope 不足 */
	USER_SCOPE_INSUFFICIENT: 99991679,
	/** access_token 无效 */
	TOKEN_INVALID: 99991668,
	/** access_token 已过期 */
	TOKEN_EXPIRED: 99991677,
	/** refresh_token 本身无效（格式非法或来自 v1 API） */
	REFRESH_TOKEN_INVALID: 20026,
	/** refresh_token 已过期（超过 365 天） */
	REFRESH_TOKEN_EXPIRED: 20037,
	/** refresh_token 已被吊销 */
	REFRESH_TOKEN_REVOKED: 20064,
	/** refresh_token 已被使用（单次消费，rotation 场景） */
	REFRESH_TOKEN_ALREADY_USED: 20073,
	/** refresh token 端点服务端内部错误，可重试 */
	REFRESH_SERVER_ERROR: 20050,
	/** 消息已被撤回 */
	MESSAGE_RECALLED: 230011,
	/** 消息已被删除 */
	MESSAGE_DELETED: 231003
};
new Set([LARK_ERROR.REFRESH_SERVER_ERROR]);
new Set([LARK_ERROR.MESSAGE_RECALLED, LARK_ERROR.MESSAGE_DELETED]);
new Set([LARK_ERROR.TOKEN_INVALID, LARK_ERROR.TOKEN_EXPIRED]);
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/dist/card/card-error.js
/**
* 收集正文里可被飞书卡片实际渲染的 markdown 表格。
*
* 代码块里的示例表格不会被飞书解析成卡片表格元素，因此这里要先排除，
* 让 shouldUseCard() 预检和 sanitizeTextForCard() 降级逻辑使用同一份结果。
*/
function findMarkdownTablesOutsideCodeBlocks(text) {
	const codeBlockRanges = [];
	const codeBlockRegex = /```[\s\S]*?```/g;
	let codeBlockMatch = codeBlockRegex.exec(text);
	while (codeBlockMatch != null) {
		codeBlockRanges.push({
			start: codeBlockMatch.index,
			end: codeBlockMatch.index + codeBlockMatch[0].length
		});
		codeBlockMatch = codeBlockRegex.exec(text);
	}
	const isInsideCodeBlock = (idx) => codeBlockRanges.some((range) => idx >= range.start && idx < range.end);
	const tableRegex = /\|.+\|[\r\n]+\|[-:| ]+\|[\s\S]*?(?=\n\n|\n(?!\|)|$)/g;
	const matches = [];
	let tableMatch = tableRegex.exec(text);
	while (tableMatch != null) {
		if (!isInsideCodeBlock(tableMatch.index)) matches.push({
			index: tableMatch.index,
			length: tableMatch[0].length,
			raw: tableMatch[0]
		});
		tableMatch = tableRegex.exec(text);
	}
	return matches;
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/src/native-tables.ts
/**
* 终态卡片把 markdown 管道表格转成飞书原生 table 组件（Card JSON 2.0）。
*
* 这是 DSH 自有业务定制（2026-11-07 自 vendor/openclaw-lark/src/card/native-tables.ts
* 外移）：经 src/streaming.ts 的 bindTerminalTables() 以 terminalCardHooks 注入
* vendor StreamingCardController 的终态整卡更新，vendor 不再感知表格业务。
*
* 背景：CardKit 流式阶段只有一个 markdown element，表格必须保持 inline；
* 终态整卡更新时才能换成原生组件。此前 dist/card/native-tables.js 是
* 没有 TS 源的编译孤儿、从未接入运行时。实现补上用户定调的三点：
*   1. 列宽按「字符数 → 固定像素」自动算，冻结首列、允许横向滚动；
*      服务端拿不到客户端画布宽度，不再猜窗口：每列按内容自然宽、下限取官方
*      80px，超出的部分由客户端横向滑动查看（PC 留白可接受，手机不再被压成省略号）。
*      固定像素不会被客户端等比压窄，故无需再加高下限来「防压缩」。
*   2. 自动推断 number / options 数据类型，数字右对齐 + 千分位；
*   3. 超过单卡预算的表格转成可读列表（不是代码块），信息不丢。
*
* 官方约束：单卡最多 5 个 table 组件；page_size 1..10（每页最多 10 行）；
* width 支持 auto / 固定像素 [80px,600px] / 百分比 [1%,100%]。
* 单元格空间不足时原生 table 只截断不换行，故固定像素下限必须足够放内容；
* 长叙述型表格（isProseTable）保留 2.0 富文本，不转成会截断的组件。
* 本模块默认仍守 markdown 时代实测的预算 3（FEISHU_CARD_TABLE_LIMIT），
* 只有显式给 maxTables 时才会放宽，避免与既有 11310 兜底口径打架。
*/
const log$2 = larkLogger("card/native-tables");
/** 一个全角字符≈2px 单位、半角≈1px 单位。 */
function displayWidth(text) {
	let units = 0;
	for (const ch of text) units += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\u3000-\u303f]/.test(ch) ? 2 : 1;
	return units;
}
/** 去掉 markdown 装饰，避免 `**加粗**` / 反引号把列宽算大。 */
function plain(value) {
	return value.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
}
/** 官方 width 下限 80px；自然权重上限 600px。 */
const MIN_WIDTH_PX = 80;
const MAX_WIDTH_PX = 600;
/**
* 卡片正文 14px：半角≈7px、全角≈14px。displayWidth() 已把全角记为 2 单位，
* 故每单位 7px。旧值 14px/单位把中文按 28px/字算，是「表头过宽」的根因。
*/
const PX_PER_UNIT = 7;
const PADDING_PX = 28;
/**
* 单列参考宽度上限（displayWidth 单位，约 13 个中文字/行）。
* 原生 table 单元格放不下长内容时是「截断」而非换行（官方文档），把整段
* 长文本算进列宽只会得到一列 600px、其余列 80px 的畸形排版。故按 p75 +
* 参考上限给自然权重，超长内容由 isProseTable 分流回富文本。
*/
const REF_UNITS = 26;
/** 单元格超过此长度（约 24 个中文字）视为叙述型，原生组件会截断，保留富文本。 */
const PROSE_CELL_UNITS = 48;
/**
* 统一固定像素布局（用户定调 2026-11-07：首列固定、其余可横向滑动）。
* 服务端拿不到客户端画布宽度，不再用百分比猜窗口：每列按内容给固定像素，
* 下限取官方 80px、上限 240px 避免单列独占。总宽超出画布时由客户端横向
* 滚动，首列始终冻结。
*
* 注意：固定像素**不会**被客户端等比压窄（这正是百分比在手机翻车的原因），
* 所以不需要人为抬高下限来「防压缩」。此前 112px 下限把「板块/方向/涨跌幅」
* 这类 2~3 字表头硬撑宽 30+px（用户反馈「表头宽度太宽」），改回按内容自然宽。
*/
const MIN_COL_PX = MIN_WIDTH_PX;
const MAX_COL_PX = 240;
const MAX_SPREAD = 2.2;
function cellUnits(text) {
	return displayWidth(plain(text));
}
function naturalWidthPx(header, cells) {
	const headerUnits = Math.min(Math.max(cellUnits(header), 1), REF_UNITS);
	const sorted = cells.map(cellUnits).sort((a, b) => a - b);
	const p75 = sorted.length ? sorted[Math.floor((sorted.length - 1) * .75)] ?? headerUnits : headerUnits;
	return Math.min(Math.max(Math.min(Math.max(headerUnits, p75), REF_UNITS) * PX_PER_UNIT + PADDING_PX, MIN_WIDTH_PX), MAX_WIDTH_PX);
}
/**
* 叙述型表格：多数单元格是长段落。原生 table 单元格不换行、超长截断，
* 转成组件反而丢信息、观感散乱；这类表保留 2.0 富文本（会换行渲染）。
*/
function isProseTable(parsed) {
	const cells = parsed.rows.flat();
	if (!cells.length) return false;
	const long = cells.filter((c) => cellUnits(c) > PROSE_CELL_UNITS).length;
	return long > 0 && long / cells.length >= .34;
}
/** 列间均衡化：把最宽/最窄的比收敛到 MAX_SPREAD 内，保持总宽不变。 */
function equalize(widths) {
	let out = [...widths];
	for (let pass = 0; pass < 3; pass++) {
		const min = Math.min(...out);
		const max = Math.max(...out);
		if (max <= min * MAX_SPREAD) break;
		const floor = Math.max(MIN_COL_PX, Math.round(max / MAX_SPREAD));
		const ceil = Math.min(MAX_COL_PX, Math.round(min * MAX_SPREAD));
		const targetSum = out.reduce((a, b) => a + b, 0);
		out = out.map((w) => Math.min(Math.max(w, floor), ceil));
		const delta = targetSum - out.reduce((a, b) => a + b, 0);
		if (delta > 0) {
			const room = out.map((w) => ceil - w);
			const roomSum = room.reduce((a, b) => a + b, 0);
			if (roomSum > 0) out = out.map((w, i) => w + Math.round(delta * ((room[i] ?? 0) / roomSum)));
		} else if (delta < 0) {
			const room = out.map((w) => w - floor);
			const roomSum = room.reduce((a, b) => a + b, 0);
			if (roomSum > 0) out = out.map((w, i) => w + Math.round(delta * ((room[i] ?? 0) / roomSum)));
		}
	}
	return out;
}
function tableLayout(parsed) {
	return {
		widths: equalize(parsed.headers.map((header, i) => naturalWidthPx(header, parsed.rows.map((row) => row[i] ?? "")))).map((w) => `${Math.min(Math.max(w, MIN_COL_PX), MAX_COL_PX)}px`),
		scroll: true
	};
}
/** 纯数字（允许 +/-、千分位、小数、百分号、亿/万单位后缀）。 */
const NUMERIC_RE = /^[+-]?\d[\d,]*(\.\d+)?%?([亿万千])?$/;
/** 有界枚举列（方向/状态等短词），转成带色的 options 标签。 */
const OPTION_VALUES = {
	"涨": "red",
	"跌": "green",
	"平": "grey",
	"买": "red",
	"卖": "green",
	"多": "red",
	"空": "green",
	"是": "green",
	"否": "red",
	"有": "green",
	"无": "grey",
	"成功": "green",
	"失败": "red",
	"启用": "green",
	"停用": "grey"
};
function inferColumnType(header, cells) {
	const values = cells.map(plain).filter(Boolean);
	if (!values.length) return "text";
	if (values.every((v) => NUMERIC_RE.test(v.replace(/\s/g, ""))) && !values.some((v) => /[%亿万千]/.test(v))) {
		const looksDecimal = values.some((v) => /\./.test(v));
		const numericHeader = /价|额|幅|率|量|值|点|涨|跌|净|流入|流出|成交|市值|收益|成本|数$/.test(plain(header));
		if (looksDecimal || numericHeader) return "number";
	}
	const distinct = new Set(values);
	if (distinct.size <= 4 && values.every((v) => v.length <= 4) && [...distinct].every((v) => v in OPTION_VALUES)) return "options";
	return values.some((v) => /\[[^\]]+\]\([^)]*\)|<[^>]+>|@\w+/.test(v)) ? "lark_md" : "text";
}
function precisionOf(cells) {
	let max = 0;
	for (const cell of cells) {
		const digits = /\.(\d+)/.exec(plain(cell))?.[1];
		if (digits) max = Math.max(max, digits.length);
	}
	return Math.min(Math.max(max, 0), 4);
}
/** 解析标准 pipe table；非法（列数不齐/无分隔行/超 50 列）返回 null，原样保留 markdown。 */
function parseMarkdownTable(raw) {
	const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("|") && l.endsWith("|"));
	if (lines.length < 3) return null;
	const [headerLine, separatorLine] = lines;
	if (!headerLine || !separatorLine) return null;
	if (!/^\|(?:\s*:?-+:?\s*\|)+$/.test(separatorLine)) return null;
	const cells = (line) => line.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
	const headers = cells(headerLine);
	if (!headers.length || headers.length > 50 || headers.some((h) => !h)) return null;
	if (cells(separatorLine).length !== headers.length) return null;
	const rows = lines.slice(2).map(cells);
	if (rows.some((row) => row.length !== headers.length)) return null;
	return {
		headers,
		rows
	};
}
/** markdown 表格分隔行（整行 `|---|---|` 形态，含 :---: / ---: 变体）。 */
const SEPARATOR_LINE_RE = /^\|(?:\s*:?-+:?\s*\|)+$/;
/**
* 把 markdown 表格分隔行统一改写成显式左对齐 `:---`（用户定调 2026-11-08：
* 列对齐全局统一，不按数据类型混排；显式 ---:/:---: 也归一到 left）。
* 应用于终态卡里残留为 markdown 的表格（长叙述/超预算不转组件的）；
* 渲染器若不支持对齐语法则无效果、无损。代码块内的分隔行是字面内容，不动。
*/
function normalizeTableSeparators(content) {
	if (!content.includes("|")) return content;
	let changed = false;
	let inFence = false;
	const lines = content.split(/\r?\n/).map((line) => {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			return line;
		}
		if (inFence) return line;
		const t = line.trim();
		if (!SEPARATOR_LINE_RE.test(t)) return line;
		changed = true;
		const count = t.slice(1, -1).split("|").length;
		return `|${Array.from({ length: count }, () => " :--- ").join("|")}|`;
	});
	return changed ? lines.join("\n") : content;
}
function tableColumns(parsed, widths) {
	return parsed.headers.map((header, i) => {
		const cells = parsed.rows.map((row) => row[i] ?? "");
		const type = inferColumnType(header, cells);
		const col = {
			name: `c${i}`,
			display_name: plain(header),
			data_type: type,
			width: widths[i] ?? `${MIN_COL_PX}px`,
			horizontal_align: "left",
			vertical_align: "top"
		};
		if (type === "number") col.format = {
			precision: precisionOf(cells),
			separator: true
		};
		return col;
	});
}
/** 单张原生 table 组件。page_size 钳到官方 1..10。 */
function buildNativeTable(parsed) {
	const columns = tableColumns(parsed, tableLayout(parsed).widths);
	const rows = parsed.rows.map((row) => Object.fromEntries(row.map((cell, i) => {
		const col = columns[i];
		const value = plain(cell);
		if (col.data_type === "options") {
			const color = OPTION_VALUES[value] ?? "blue";
			return [col.name, [{
				text: value,
				color
			}]];
		}
		return [col.name, col.data_type === "number" ? Number(value.replace(/[,%亿万]/g, "")) || 0 : value];
	})));
	return {
		tag: "table",
		page_size: Math.min(Math.max(parsed.rows.length, 1), 10),
		row_height: "low",
		freeze_first_column: true,
		header_style: {
			text_align: "left",
			text_size: "normal",
			background_style: "grey",
			text_color: "default",
			bold: true,
			lines: 1
		},
		columns,
		rows
	};
}
/** 超预算表格的可读降级：表头标一次、按行分块，宽表不挤成一行。 */
function readableTable(parsed) {
	const headers = parsed.headers.map(plain);
	return parsed.rows.map((row) => `- ${headers.map((h, i) => `**${h}**：${plain(row[i] ?? "")}`).join("；")}`).join("\n");
}
/** optimizeMarkdownStyle 插的纯占位行不值得单独占一个 element。 */
function meaningful(text) {
	return text.replace(/<br\s*\/?>/gi, "").trim().length > 0;
}
/**
* 把终态卡片 body.elements 里的 markdown 管道表格换成原生 table 组件。
*
* - 只对 `tag: 'markdown'` 且 content 是字符串的元素生效；其它组件原样保留。
* - 表格前后的普通文本仍按 markdown 元素输出（顺序保持不变）。
* - 超过 maxTables 的表格转成可读列表（仍是 markdown 文本），信息不丢。
* - 代码块里的表格不会被误转（findMarkdownTablesOutsideCodeBlocks 已排除）。
*/
function convertMarkdownTablesToNative(card, options = {}) {
	const body = card.body ?? card;
	if (!body?.elements) return card;
	let remaining = options.maxTables ?? 3;
	let hasTable = false;
	const elements = [];
	for (const element of body.elements) {
		if (element.tag !== "markdown" || typeof element.content !== "string") {
			elements.push(element);
			continue;
		}
		const text = element.content;
		const rawMatches = findMarkdownTablesOutsideCodeBlocks(text);
		if (!rawMatches.length) {
			elements.push(element);
			continue;
		}
		let cursor = 0;
		let elementHadTable = false;
		for (const match of rawMatches) {
			const parsed = parseMarkdownTable(match.raw);
			if (!parsed || isProseTable(parsed)) continue;
			const before = text.slice(cursor, match.index);
			if (meaningful(before)) elements.push({
				...element,
				content: before.trim()
			});
			if (remaining > 0) {
				elements.push(buildNativeTable(parsed));
				remaining -= 1;
				hasTable = true;
			} else elements.push({
				...element,
				content: readableTable(parsed)
			});
			elementHadTable = true;
			cursor = match.index + match.length;
		}
		if (!elementHadTable) {
			elements.push(element);
			continue;
		}
		const tail = text.slice(cursor);
		if (meaningful(tail)) elements.push({
			...element,
			content: tail.trim()
		});
	}
	let separatorsChanged = false;
	const normalized = elements.map((element) => {
		if (element.tag !== "markdown" || typeof element.content !== "string") return element;
		const content = normalizeTableSeparators(element.content);
		if (content === element.content) return element;
		separatorsChanged = true;
		return {
			...element,
			content
		};
	});
	return hasTable || separatorsChanged ? card.body ? {
		...card,
		body: {
			...body,
			elements: normalized
		}
	} : {
		...card,
		elements: normalized
	} : card;
}
/**
* 宿主终态卡变换（经 src/streaming.ts 的 bindTerminalTables 注入 vendor
* StreamingCardController 的 terminalCardHooks.transformTerminalCard）：
* markdown 管道表格 → 原生 table 组件，并打诊断日志。
*/
function transformTerminalCardTables(kit) {
	const converted = convertMarkdownTablesToNative(kit);
	try {
		const elements = converted.body?.elements ?? converted.elements ?? [];
		const tableEls = elements.filter((el) => el?.tag === "table");
		log$2.info("native-table terminal elements", {
			mode: "native",
			total: elements.length,
			tables: tableEls.length,
			tags: elements.map((el) => String(el?.tag ?? "?")).slice(0, 12),
			widths: tableEls.map((t) => (t.columns ?? []).map((c) => c.width).join("/")).slice(0, 3)
		});
	} catch {}
	return converted;
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/src/dsbot-streaming.ts
const defaultFactory = (deps) => new StreamingCardController(deps);
/**
* 按插件配置的 tableRenderMode 绑定终态卡钩子（模式唯一权威入口）：
* - native：给每个 turn 的终态整卡挂 transformTerminalCardTables（markdown
*   管道表格 → 原生 table 组件），vendor 控制器同时跳过内置代码块降级；
* - markdown（缺省）：不注入钩子，行为与旧版完全一致。
* base 缺省用官方 controller 直连工厂。
*/
function bindTerminalTables(mode, base) {
	const factory = base ?? defaultFactory;
	if (mode !== "native") return factory;
	return (deps) => factory({
		...deps,
		terminalCardHooks: { transformTerminalCard: transformTerminalCardTables }
	});
}
/** One official CardKit turn. No legacy card builder or legacy fallback exists here. */
var OfficialTurnStream = class {
	controller;
	queue = Promise.resolve();
	traceStarted = false;
	constructor(sessionKey, chatId, replyToMessageId, cfg, factory = defaultFactory, accountId, notification) {
		this.sessionKey = sessionKey;
		this.controller = factory({
			cfg,
			agentId: "dsh",
			sessionKey,
			accountId,
			chatId,
			replyToMessageId,
			...notification ? { notification } : {},
			replyInThread: false,
			toolUseDisplay: {
				mode: "on",
				showToolUse: true,
				showToolResultDetails: false,
				showFullPaths: false
			},
			resolvedFooter: {
				status: false,
				elapsed: false,
				tokens: false,
				cache: false,
				context: false,
				model: false
			}
		});
	}
	get phase() {
		return this.controller.currentPhase;
	}
	get messageId() {
		return this.controller.cardMessageId;
	}
	beginTrace() {
		if (this.traceStarted) return;
		startToolUseTraceRun(this.sessionKey);
		this.traceStarted = true;
	}
	async start() {
		this.beginTrace();
		await this.controller.ensureCardCreated();
	}
	text(snapshot) {
		this.beginTrace();
		return this.enqueue(() => this.controller.onPartialReply({ text: snapshot }));
	}
	reasoning(_snapshot) {
		return Promise.resolve();
	}
	toolStart(input) {
		return this.enqueue(async () => {
			this.beginTrace();
			recordToolUseStart({
				sessionKey: this.sessionKey,
				toolName: input.name,
				...input.callId !== void 0 ? { toolCallId: input.callId } : {},
				...input.params !== void 0 ? { toolParams: input.params } : {}
			});
			await this.controller.onToolStart({
				name: input.name,
				phase: "start"
			});
		});
	}
	toolEnd(input) {
		return this.enqueue(async () => {
			recordToolUseEnd({
				sessionKey: this.sessionKey,
				toolName: input.name,
				...input.callId !== void 0 ? { toolCallId: input.callId } : {},
				...input.params !== void 0 ? { toolParams: input.params } : {},
				result: input.result,
				...input.error !== void 0 ? { error: input.error } : {},
				...input.durationMs !== void 0 ? { durationMs: input.durationMs } : {}
			});
			await this.controller.onToolPayload({ text: "" });
		});
	}
	complete(answer) {
		this.beginTrace();
		return this.enqueue(async () => {
			if (answer.trim() && this.phase !== "completed") await this.controller.onDeliver({ text: answer });
			this.controller.markFullyComplete();
			await this.controller.onIdle();
		});
	}
	fail(error) {
		return this.enqueue(() => this.controller.onError(error, { kind: "turn" }));
	}
	abort() {
		return this.enqueue(() => this.controller.abortCard());
	}
	enqueue(operation) {
		const next = this.queue.then(operation, operation);
		this.queue = next.catch(() => {});
		return next;
	}
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/inbound/user-name-cache-store.ts
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Account-scoped cache registry for Feishu user display names.
*
* Stores forward (openId → name + kind) and reverse (normalizedName → Set<openId>)
* indexes for mention resolution. Per-account, LRU + TTL.
*/
const DEFAULT_MAX_SIZE = 500;
const DEFAULT_TTL_MS = 1800 * 1e3;
const DEFAULT_MAX_CHATS = 200;
function normalizeName(name) {
	return name.trim().toLowerCase();
}
var UserNameCache = class {
	nameByOpenId = /* @__PURE__ */ new Map();
	openIdsByName = /* @__PURE__ */ new Map();
	maxSize;
	ttlMs;
	chatBots = /* @__PURE__ */ new Map();
	chatMembers = /* @__PURE__ */ new Map();
	inFlight = /* @__PURE__ */ new Map();
	maxChats;
	constructor(maxSize = DEFAULT_MAX_SIZE, ttlMs = DEFAULT_TTL_MS, maxChats = DEFAULT_MAX_CHATS) {
		this.maxSize = maxSize;
		this.ttlMs = ttlMs;
		this.maxChats = maxChats;
	}
	has(openId) {
		const entry = this.nameByOpenId.get(openId);
		if (!entry) return false;
		if (entry.expireAt <= Date.now()) {
			this.deleteOpenId(openId);
			return false;
		}
		return true;
	}
	get(openId) {
		const entry = this.nameByOpenId.get(openId);
		if (!entry) return void 0;
		if (entry.expireAt <= Date.now()) {
			this.deleteOpenId(openId);
			return;
		}
		this.nameByOpenId.delete(openId);
		this.nameByOpenId.set(openId, entry);
		return entry.name;
	}
	set(openId, name) {
		this.writeEntry(openId, name, void 0);
	}
	setWithKind(openId, name, kind) {
		this.writeEntry(openId, name, kind);
	}
	lookupByName(name) {
		const key = normalizeName(name);
		const ids = this.openIdsByName.get(key);
		if (!ids || ids.size === 0) return [];
		const matches = [];
		for (const openId of ids) {
			const entry = this.nameByOpenId.get(openId);
			if (!entry) continue;
			if (entry.expireAt <= Date.now()) {
				this.deleteOpenId(openId);
				continue;
			}
			matches.push({
				openId,
				name: entry.name,
				kind: entry.kind
			});
		}
		return matches;
	}
	setMany(entries) {
		for (const [openId, name] of entries) this.writeEntryNoEvict(openId, name, void 0);
		this.evict();
	}
	filterMissing(openIds) {
		return openIds.filter((id) => !this.has(id));
	}
	getMany(openIds) {
		const result = /* @__PURE__ */ new Map();
		for (const id of openIds) if (this.has(id)) result.set(id, this.get(id) ?? "");
		return result;
	}
	recordChatBots(chatId, members) {
		const enriched = members.map((m) => ({
			...m,
			kind: "bot"
		}));
		this.chatBots.delete(chatId);
		this.chatBots.set(chatId, {
			members: enriched,
			expireAt: Date.now() + this.ttlMs
		});
		this.evictChats(this.chatBots);
		for (const m of enriched) if (m.openId) this.writeEntryNoEvict(m.openId, m.name, "bot");
		this.evict();
	}
	recordChatMembers(chatId, members) {
		const enriched = members.slice();
		this.chatMembers.delete(chatId);
		this.chatMembers.set(chatId, {
			members: enriched,
			expireAt: Date.now() + this.ttlMs
		});
		this.evictChats(this.chatMembers);
		for (const m of enriched) if (m.openId) this.writeEntryNoEvict(m.openId, m.name, m.kind);
		this.evict();
	}
	getChatBots(chatId) {
		const entry = this.chatBots.get(chatId);
		if (!entry) return null;
		if (entry.expireAt <= Date.now()) {
			this.chatBots.delete(chatId);
			return null;
		}
		return entry;
	}
	getChatMembers(chatId) {
		const entry = this.chatMembers.get(chatId);
		if (!entry) return null;
		if (entry.expireAt <= Date.now()) {
			this.chatMembers.delete(chatId);
			return null;
		}
		return entry;
	}
	getInflight(key) {
		return this.inFlight.get(key);
	}
	setInflight(key, promise) {
		this.inFlight.set(key, promise);
	}
	clearInflight(key) {
		this.inFlight.delete(key);
	}
	clear() {
		this.nameByOpenId.clear();
		this.openIdsByName.clear();
		this.chatBots.clear();
		this.chatMembers.clear();
		this.inFlight.clear();
	}
	writeEntry(openId, name, kind) {
		this.writeEntryNoEvict(openId, name, kind);
		this.evict();
	}
	writeEntryNoEvict(openId, name, kind) {
		const old = this.nameByOpenId.get(openId);
		if (old) {
			const oldKey = normalizeName(old.name);
			if (oldKey !== normalizeName(name)) this.removeFromReverse(oldKey, openId);
		}
		this.nameByOpenId.delete(openId);
		this.nameByOpenId.set(openId, {
			name,
			kind,
			expireAt: Date.now() + this.ttlMs
		});
		const key = normalizeName(name);
		let bucket = this.openIdsByName.get(key);
		if (!bucket) {
			bucket = /* @__PURE__ */ new Set();
			this.openIdsByName.set(key, bucket);
		}
		bucket.add(openId);
	}
	deleteOpenId(openId) {
		const entry = this.nameByOpenId.get(openId);
		if (!entry) return;
		this.nameByOpenId.delete(openId);
		this.removeFromReverse(normalizeName(entry.name), openId);
	}
	removeFromReverse(key, openId) {
		const bucket = this.openIdsByName.get(key);
		if (!bucket) return;
		bucket.delete(openId);
		if (bucket.size === 0) this.openIdsByName.delete(key);
	}
	evictChats(map) {
		while (map.size > this.maxChats) {
			const oldest = map.keys().next().value;
			if (oldest === void 0) break;
			map.delete(oldest);
		}
	}
	evict() {
		while (this.nameByOpenId.size > this.maxSize) {
			const oldest = this.nameByOpenId.keys().next().value;
			if (oldest === void 0) break;
			this.deleteOpenId(oldest);
		}
	}
};
const registry = /* @__PURE__ */ new Map();
function getUserNameCache(accountId) {
	let c = registry.get(accountId);
	if (!c) {
		c = new UserNameCache();
		registry.set(accountId, c);
	}
	return c;
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/utils.ts
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Shared utilities for content converters.
*/
/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
* Safely parse a JSON string, returning undefined on failure.
*/
function safeParse(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return;
	}
}
/**
* Format a duration in milliseconds to a human-readable string.
*
* Examples: 1500 → "1.5s", 65000 → "65s"
*/
function formatDuration(ms) {
	const seconds = ms / 1e3;
	if (seconds < 1) return `${ms}ms`;
	if (Number.isInteger(seconds)) return `${seconds}s`;
	return `${seconds.toFixed(1)}s`;
}
/**
* Convert a millisecond timestamp to "YYYY-MM-DD HH:mm" in UTC+8 (Beijing time).
*/
function millisToDatetime(ms) {
	const num = Number(ms);
	if (!Number.isFinite(num)) return String(ms);
	const d = new Date(num + 480 * 60 * 1e3);
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/content-converter-helpers.ts
/** 从 mention 的 id 字段提取 open_id（兼容事件推送的对象格式和 API 响应的字符串格式） */
function extractMentionOpenId(id) {
	if (typeof id === "string") return id;
	if (id != null && typeof id === "object" && "open_id" in id) {
		const openId = id.open_id;
		return typeof openId === "string" ? openId : "";
	}
	return "";
}
/**
* Build a {@link ConvertContext} from a raw Feishu API message item.
*
* Extracts the `mentions` array that the IM API returns on each message
* item and maps it into the key→MentionInfo / openId→MentionInfo
* structures the converter system expects.
*/
function buildConvertContextFromItem(item, fallbackMessageId, accountId) {
	const mentions = /* @__PURE__ */ new Map();
	const mentionsByOpenId = /* @__PURE__ */ new Map();
	for (const m of item.mentions ?? []) {
		const openId = extractMentionOpenId(m.id);
		if (!openId) continue;
		const info = {
			key: m.key,
			openId,
			name: m.name ?? "",
			isBot: false
		};
		mentions.set(m.key, info);
		mentionsByOpenId.set(openId, info);
	}
	return {
		mentions,
		mentionsByOpenId,
		messageId: item.message_id ?? fallbackMessageId,
		accountId,
		resolveUserName: accountId ? (openId) => getUserNameCache(accountId).get(openId) : void 0
	};
}
/**
* Resolve mention placeholders in text.
*
* - Bot self-mention + stripBotMentions: leading-only strip. When the
*   self-mention sits at the very start of the message, drop it (the
*   `WasMentioned` envelope field already tells the agent "this message
*   was addressed to you", so the anchor is redundant). When it appears
*   mid-text, render it as plain `@Name` so the surrounding context still
*   reads naturally without leaving an inline anchor the LLM might echo
*   back into its reply.
* - Non-bot mentions: replace the placeholder key with readable `@name`.
*/
function resolveMentions(text, ctx) {
	if (ctx.mentions.size === 0) return text;
	let result = text;
	for (const [key, info] of ctx.mentions) if (info.isBot && ctx.stripBotMentions) {
		result = result.replace(new RegExp(escapeRegExp(key), "g"), `@${info.name}`);
		const leadingPattern = new RegExp(`^\\s*@${escapeRegExp(info.name)}[\\s,，:：]*`);
		result = result.replace(leadingPattern, "").trimStart();
	} else result = result.replace(new RegExp(escapeRegExp(key), "g"), `@${info.name}`);
	return result;
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/text.ts
const convertText = (raw, ctx) => {
	return {
		content: resolveMentions(safeParse(raw)?.text ?? raw, ctx),
		resources: []
	};
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/post.ts
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Converter for "post" (rich text) message type.
*
* Preserves structure as Markdown: links as `[text](href)`,
* images as `![image](key)`, code blocks, and mention resolution.
*/
const log$1 = larkLogger$1("converters/post");
/** Preferred locale order for multi-language post unwrapping. */
const LOCALE_PRIORITY = [
	"zh_cn",
	"en_us",
	"ja_jp"
];
/**
* Scan token for native markdown: a code region to SKIP, OR an image to intercept.
* Group 1 (code region) matches first so `![alt](key)` inside code is consumed
* verbatim and never intercepted:
*   - fenced block: ```...``` or ~~~...~~~ (multi-line, lazy)
*   - inline span:  ``...`` or `...` (single-line)
* Group 2 (alt) + Group 3 (target) are the image when no code region matched.
*/
const MD_SCAN_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[^`\n]*`)|!\[([^\]]*)\]\(([^)]+)\)/g;
/** Feishu image_key prefix (aligned with markdown-style.ts stripInvalidImageKeys & case 'img'). */
const FEISHU_IMAGE_KEY_RE = /^img_/;
/**
* Inbound native-markdown size ceiling (chars). Guards against pathological
* posts (huge tables / deep nesting) blowing up memory/token before the
* downstream chunker runs. One order above the outbound chunk magnitude
* (outbound default 15000). Tunable; per-account config override is a follow-up.
*/
const MAX_INBOUND_MD_LEN = 1e5;
/**
* Unwrap a parsed post object that may be locale-wrapped.
*
* Feishu post messages come in two shapes:
*   - Flat:   `{ title, content }`
*   - Locale: `{ zh_cn: { title, content }, en_us: { title, content } }`
*/
function unwrapLocale(parsed) {
	if ("title" in parsed || "content" in parsed || "content_v2" in parsed) return parsed;
	for (const locale of LOCALE_PRIORITY) {
		const localeData = parsed[locale];
		if (localeData != null && typeof localeData === "object") return localeData;
	}
	const firstKey = Object.keys(parsed)[0];
	if (firstKey) {
		const firstValue = parsed[firstKey];
		if (firstValue != null && typeof firstValue === "object") return firstValue;
	}
}
const convertPost = (raw, ctx) => {
	const rawParsed = safeParse(raw);
	if (rawParsed == null || typeof rawParsed !== "object") return {
		content: "[rich text message]",
		resources: []
	};
	const parsed = unwrapLocale(rawParsed);
	if (!parsed) return {
		content: "[rich text message]",
		resources: []
	};
	const resources = [];
	const lines = [];
	const seenFileKeys = /* @__PURE__ */ new Set();
	if (parsed.title) lines.push(`**${parsed.title}**`, "");
	const v2 = parsed.content_v2;
	const usedV2 = Array.isArray(v2) && v2.length > 0;
	const contentBlocks = usedV2 ? v2 : parsed.content ?? [];
	log$1.info("post content source selected", {
		messageId: ctx.messageId,
		source: usedV2 ? "content_v2" : "content",
		hasV2: Array.isArray(v2),
		v2Len: Array.isArray(v2) ? v2.length : 0
	});
	for (const paragraph of contentBlocks) {
		if (!Array.isArray(paragraph)) continue;
		let line = "";
		for (const el of paragraph) line += renderElement(el, ctx, resources, seenFileKeys);
		lines.push(line);
	}
	let content = lines.join("\n").trim() || "[rich text message]";
	content = resolveMentions(content, ctx);
	content = capInboundLength(content, resources);
	return {
		content,
		resources
	};
};
function renderElement(el, ctx, resources, seenFileKeys) {
	switch (el.tag) {
		case "text": {
			let text = el.text ?? "";
			text = applyStyle(text, el.style);
			return text;
		}
		case "a": {
			const text = el.text ?? el.href ?? "";
			return el.href ? `[${text}](${el.href})` : text;
		}
		case "at": {
			const userId = el.user_id ?? "";
			if (userId === "all") return "@all";
			const name = el.user_name ?? userId;
			const info = ctx.mentionsByOpenId.get(userId);
			if (info) return info.key;
			return `@${name}`;
		}
		case "img":
			if (el.image_key) {
				resources.push({
					type: "image",
					fileKey: el.image_key
				});
				return `![image](${el.image_key})`;
			}
			return "";
		case "media":
			if (el.file_key) {
				resources.push({
					type: "file",
					fileKey: el.file_key
				});
				return `<file key="${el.file_key}"/>`;
			}
			return "";
		case "md": return renderInlineImages(el.text ?? "", resources, seenFileKeys);
		case "code_block": return `\n\`\`\`${el.language ?? ""}\n${el.text ?? ""}\n\`\`\`\n`;
		case "hr": return "\n---\n";
		default: return el.text ?? "";
	}
}
function applyStyle(text, style) {
	if (!style || style.length === 0) return text;
	let result = text;
	if (style.includes("bold")) result = `**${result}**`;
	if (style.includes("italic")) result = `*${result}*`;
	if (style.includes("underline")) result = `<u>${result}</u>`;
	if (style.includes("lineThrough")) result = `~~${result}~~`;
	if (style.includes("codeInline")) result = `\`${result}\``;
	return result;
}
/**
* Scan native markdown for `![alt](target)` and intercept feishu image_keys.
* - target matches `^img_` → register a downloadable resource (Set-deduped) and
*   normalize the FIRST occurrence to `![image](key)` (the only form
*   substituteMediaPaths can replace); later occurrences of the same key collapse
*   to sanitized alt text so no bare key / un-replaceable marker leaks downstream.
* - everything else (https/http, data:, protocol-relative, relative/anchor) is kept
*   verbatim and never downloaded.
* Image syntax inside a code region (fenced block or inline span) is left verbatim
* and never intercepted — code is shown as-is, not rendered.
*/
function renderInlineImages(md, resources, seen) {
	return md.replace(MD_SCAN_RE, (whole, codeRegion, alt, target) => {
		if (codeRegion !== void 0) return whole;
		if (!FEISHU_IMAGE_KEY_RE.test(target)) return whole;
		if (!seen.has(target)) {
			seen.add(target);
			resources.push({
				type: "image",
				fileKey: target
			});
			return `![image](${target})`;
		}
		return sanitizeAlt(alt);
	});
}
/** Strip nested image syntax and bare feishu keys from alt so it cannot be
*  re-matched by substituteMediaPaths nor inject UGC markers. */
function sanitizeAlt(alt) {
	return alt.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/img_[A-Za-z0-9_-]+/g, "").trim();
}
/**
* Cap inbound text length at a safe boundary (never split an `![image](key)`
* marker), tag `[truncated]`, and drop image resources whose marker fell off the
* end so we never register an orphan download with no in-text marker.
*/
function capInboundLength(content, resources) {
	if (content.length <= MAX_INBOUND_MD_LEN) return content;
	let cut = content.lastIndexOf("\n", MAX_INBOUND_MD_LEN);
	if (cut <= 0) {
		cut = MAX_INBOUND_MD_LEN;
		const markerStart = content.lastIndexOf("![image](", cut);
		if (markerStart !== -1) {
			const markerEnd = content.indexOf(")", markerStart);
			if (markerEnd === -1 || markerEnd >= cut) cut = markerStart;
		}
	}
	const truncated = `${content.slice(0, cut).replace(/\s+$/, "")}\n[truncated]`;
	for (let i = resources.length - 1; i >= 0; i--) {
		const r = resources[i];
		if (r.type === "image" && !truncated.includes(`![image](${r.fileKey})`)) resources.splice(i, 1);
	}
	return truncated;
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/image.ts
const convertImage = (raw) => {
	const imageKey = safeParse(raw)?.image_key;
	if (!imageKey) return {
		content: "[image]",
		resources: []
	};
	return {
		content: `![image](${imageKey})`,
		resources: [{
			type: "image",
			fileKey: imageKey
		}]
	};
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/file.ts
const convertFile = (raw) => {
	const parsed = safeParse(raw);
	const fileKey = parsed?.file_key;
	if (!fileKey) return {
		content: "[file]",
		resources: []
	};
	const fileName = parsed?.file_name ?? "";
	return {
		content: `<file key="${fileKey}"${fileName ? ` name="${fileName}"` : ""}/>`,
		resources: [{
			type: "file",
			fileKey,
			fileName: fileName || void 0
		}]
	};
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/audio.ts
const convertAudio = (raw) => {
	const parsed = safeParse(raw);
	const fileKey = parsed?.file_key;
	if (!fileKey) return {
		content: "[audio]",
		resources: []
	};
	const duration = parsed?.duration;
	return {
		content: `<audio key="${fileKey}"${duration != null ? ` duration="${formatDuration(duration)}"` : ""}/>`,
		resources: [{
			type: "audio",
			fileKey,
			duration: duration ?? void 0
		}]
	};
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/video.ts
const convertVideo = (raw) => {
	const parsed = safeParse(raw);
	const fileKey = parsed?.file_key;
	if (!fileKey) return {
		content: "[video]",
		resources: []
	};
	const fileName = parsed?.file_name ?? "";
	const duration = parsed?.duration;
	const coverKey = parsed?.image_key;
	return {
		content: `<video key="${fileKey}"${fileName ? ` name="${fileName}"` : ""}${duration != null ? ` duration="${formatDuration(duration)}"` : ""}/>`,
		resources: [{
			type: "video",
			fileKey,
			fileName: fileName || void 0,
			duration: duration ?? void 0,
			coverImageKey: coverKey ?? void 0
		}]
	};
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/sticker.ts
const convertSticker = (raw) => {
	const fileKey = safeParse(raw)?.file_key;
	if (!fileKey) return {
		content: "[sticker]",
		resources: []
	};
	return {
		content: `<sticker key="${fileKey}"/>`,
		resources: [{
			type: "sticker",
			fileKey
		}]
	};
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/interactive/types.ts
const EMOJI_MAP = {
	OK: "👌",
	THUMBSUP: "👍",
	SMILE: "😊",
	HEART: "❤️",
	CLAP: "👏",
	FIRE: "🔥",
	PARTY: "🎉",
	THINK: "🤔"
};
const CHART_TYPE_NAMES = {
	bar: "柱状图",
	line: "折线图",
	pie: "饼图",
	area: "面积图",
	radar: "雷达图",
	scatter: "散点图"
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/interactive/card-utils.ts
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Utility functions for card content conversion.
*/
function escapeAttr(s) {
	return s.replace(/"/g, "\\\"").replace(/\n/g, "\\n");
}
function formatMillisecondsToISO8601(milliseconds) {
	const ms = parseInt(milliseconds, 10);
	if (isNaN(ms)) return "";
	return new Date(ms).toISOString();
}
function normalizeTimeFormat(input) {
	if (!input) return "";
	const num = parseInt(input, 10);
	if (!isNaN(num) && String(num) === input.trim()) {
		if (input.length >= 13) return new Date(num).toISOString();
		else if (input.length >= 10) return (/* @__PURE__ */ new Date(num * 1e3)).toISOString();
	}
	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(input)) return input;
	const dtMatch = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)$/.exec(input);
	if (dtMatch) {
		const d = /* @__PURE__ */ new Date(`${dtMatch[1]}T${dtMatch[2]}`);
		if (!isNaN(d.getTime())) return d.toISOString();
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
	if (/^\d{2}:\d{2}(:\d{2})?$/.test(input)) return input;
	return input;
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/interactive/card-converter.ts
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*/
const MODE = {
	Concise: 0,
	Detailed: 1
};
const elementConverters = new Map([
	["plain_text", (c, _elem, prop) => c.convertPlainText(prop)],
	["markdown", (c, _elem, prop) => c.convertMarkdown(prop)],
	["markdown_v1", (c, elem, prop) => c.convertMarkdownV1(elem, prop)],
	["text", (c, _elem, prop) => c.convertPlainText(prop)],
	["div", (c, _elem, prop, id) => c.convertDiv(prop, id)],
	["note", (c, _elem, prop) => c.convertNote(prop)],
	["hr", () => "---"],
	["br", () => "\n"],
	["column_set", (c, _elem, prop, _id, depth) => c.convertColumnSet(prop, depth)],
	["column", (c, _elem, prop, _id, depth) => c.convertColumn(prop, depth)],
	["person", (c, _elem, prop, id) => c.convertPerson(prop, id)],
	["person_v1", (c, _elem, prop, id) => c.convertPersonV1(prop, id)],
	["person_list", (c, _elem, prop) => c.convertPersonList(prop)],
	["avatar", (c, _elem, prop, id) => c.convertAvatar(prop, id)],
	["at", (c, _elem, prop) => c.convertAt(prop)],
	["at_all", () => "@所有人"],
	["button", (c, _elem, prop, id) => c.convertButton(prop, id)],
	["actions", (c, _elem, prop) => c.convertActions(prop)],
	["action", (c, _elem, prop) => c.convertActions(prop)],
	["overflow", (c, _elem, prop) => c.convertOverflow(prop)],
	["select_static", (c, _elem, prop, id) => c.convertSelect(prop, id, false)],
	["multi_select_static", (c, _elem, prop, id) => c.convertSelect(prop, id, true)],
	["select_person", (c, _elem, prop, id) => c.convertSelect(prop, id, false)],
	["multi_select_person", (c, _elem, prop, id) => c.convertSelect(prop, id, true)],
	["select_img", (c, _elem, prop, id) => c.convertSelectImg(prop, id)],
	["input", (c, _elem, prop, id) => c.convertInput(prop, id)],
	["date_picker", (c, _elem, prop, id) => c.convertDatePicker(prop, id, "date")],
	["picker_time", (c, _elem, prop, id) => c.convertDatePicker(prop, id, "time")],
	["picker_datetime", (c, _elem, prop, id) => c.convertDatePicker(prop, id, "datetime")],
	["checker", (c, _elem, prop, id) => c.convertChecker(prop, id)],
	["img", (c, _elem, prop, id) => c.convertImage(prop, id)],
	["image", (c, _elem, prop, id) => c.convertImage(prop, id)],
	["img_combination", (c, _elem, prop) => c.convertImgCombination(prop)],
	["table", (c, _elem, prop) => c.convertTable(prop)],
	["chart", (c, _elem, prop, id) => c.convertChart(prop, id)],
	["audio", (c, _elem, prop, id) => c.convertAudio(prop, id)],
	["video", (c, _elem, prop, id) => c.convertVideo(prop, id)],
	["collapsible_panel", (c, _elem, prop, id) => c.convertCollapsiblePanel(prop, id)],
	["form", (c, _elem, prop, id) => c.convertForm(prop, id)],
	["interactive_container", (c, _elem, prop, id) => c.convertInteractiveContainer(prop, id)],
	["text_tag", (c, _elem, prop) => c.convertTextTag(prop)],
	["number_tag", (c, _elem, prop) => c.convertNumberTag(prop)],
	["link", (c, _elem, prop) => c.convertLink(prop)],
	["emoji", (c, _elem, prop) => c.convertEmoji(prop)],
	["local_datetime", (c, _elem, prop) => c.convertLocalDatetime(prop)],
	["list", (c, _elem, prop) => c.convertList(prop)],
	["blockquote", (c, _elem, prop) => c.convertBlockquote(prop)],
	["code_block", (c, _elem, prop) => c.convertCodeBlock(prop)],
	["code_span", (c, _elem, prop) => c.convertCodeSpan(prop)],
	["heading", (c, _elem, prop) => c.convertHeading(prop)],
	["fallback_text", (c, _elem, prop) => c.convertFallbackText(prop)],
	["repeat", (c, _elem, prop) => c.convertRepeat(prop)],
	["card_header", () => ""],
	["custom_icon", () => ""],
	["standard_icon", () => ""]
]);
var CardConverter = class {
	mode;
	attachment;
	constructor(mode) {
		this.mode = mode;
	}
	convert(input) {
		const card = safeParse(input.json_card);
		if (!card) return {
			content: "<card>\n[无法解析卡片内容]\n</card>",
			schema: 0
		};
		if (input.json_attachment) this.attachment = safeParse(input.json_attachment);
		let schema = input.card_schema ?? 0;
		if (schema === 0) {
			const s = card.schema;
			schema = typeof s === "number" ? s : 1;
		}
		const header = card.header;
		const title = header ? this.extractHeaderTitle(header, schema) : "";
		const body = this.extractBody(card, schema);
		const bodyContent = body ? this.convertBody(body, schema) : "";
		let out = title ? `<card title="${escapeAttr(title)}">\n` : "<card>\n";
		if (bodyContent) out += bodyContent + "\n";
		out += "</card>";
		return {
			content: out,
			schema
		};
	}
	extractBody(card, _schema) {
		if (card.body && typeof card.body === "object") return card.body;
	}
	extractHeaderTitle(header, _schema) {
		const prop = header.property;
		if (prop) {
			const titleElem = prop.title;
			if (titleElem) return this.extractTextContent(titleElem);
		} else {
			const titleElem = header.title;
			if (titleElem) return this.extractTextContent(titleElem);
		}
		return "";
	}
	convertBody(body, _schema) {
		let elements;
		const prop = body.property;
		if (prop) {
			const e = prop.elements;
			if (Array.isArray(e) && e.length > 0) elements = e;
		}
		if (!elements || elements.length === 0) {
			const e = body.elements;
			if (Array.isArray(e)) elements = e;
		}
		if (!elements || elements.length === 0) return "";
		return this.convertElements(elements, 0);
	}
	convertElements(elements, depth) {
		const results = [];
		for (const elem of elements) {
			if (typeof elem !== "object" || elem == null) continue;
			const result = this.convertElement(elem, depth);
			if (result) results.push(result);
		}
		return results.join("\n");
	}
	convertElement(elem, depth) {
		const tag = elem.tag ?? "";
		const id = elem.id ?? "";
		const prop = this.extractProperty(elem);
		const fn = elementConverters.get(tag);
		if (fn) return fn(this, elem, prop, id, depth);
		return this.convertUnknown(prop, tag);
	}
	extractProperty(elem) {
		if (elem.property && typeof elem.property === "object") return elem.property;
		return elem;
	}
	extractTextContent(textElem) {
		if (textElem == null) return "";
		if (typeof textElem === "string") return textElem;
		if (typeof textElem === "object") {
			const m = textElem;
			if (m.property && typeof m.property === "object") return this.extractTextFromProperty(m.property);
			return this.extractTextFromProperty(m);
		}
		return "";
	}
	extractTextFromProperty(prop) {
		const i18n = prop.i18nContent;
		if (i18n && typeof i18n === "object") for (const lang of [
			"zh_cn",
			"en_us",
			"ja_jp"
		]) {
			const t = i18n[lang];
			if (typeof t === "string" && t) return t;
		}
		if (typeof prop.content === "string") return prop.content;
		const elements = prop.elements;
		if (Array.isArray(elements) && elements.length > 0) {
			const texts = [];
			for (const elem of elements) if (typeof elem === "object" && elem != null) {
				const t = this.extractTextContent(elem);
				if (t) texts.push(t);
			}
			return texts.join("");
		}
		if (typeof prop.text === "string") return prop.text;
		return "";
	}
	convertPlainText(prop) {
		const content = prop.content;
		if (!content) return "";
		const style = this.extractTextStyle(prop);
		return this.applyTextStyle(content, style);
	}
	convertMarkdown(prop) {
		const elements = prop.elements;
		if (Array.isArray(elements) && elements.length > 0) return this.convertMarkdownElements(elements);
		if (typeof prop.content === "string") return prop.content;
		return "";
	}
	convertMarkdownV1(elem, prop) {
		const elements = prop.elements;
		if (Array.isArray(elements) && elements.length > 0) return this.convertMarkdownElements(elements);
		const fallback = elem.fallback;
		if (fallback && typeof fallback === "object") return this.convertElement(fallback, 0);
		if (typeof prop.content === "string") return prop.content;
		return "";
	}
	convertMarkdownElements(elements) {
		const parts = [];
		for (const elem of elements) {
			if (typeof elem !== "object" || elem == null) continue;
			const result = this.convertElement(elem, 0);
			if (result) parts.push(result);
		}
		return parts.join("");
	}
	convertDiv(prop, _id) {
		const results = [];
		const textElem = prop.text;
		if (textElem && typeof textElem === "object") {
			const text = this.convertElement(textElem, 0);
			if (text) results.push(text);
		}
		const fields = prop.fields;
		if (Array.isArray(fields) && fields.length > 0) {
			const fieldTexts = [];
			for (const field of fields) {
				if (typeof field !== "object" || field == null) continue;
				const te = field.text;
				if (te && typeof te === "object") {
					const ft = this.convertElement(te, 0);
					if (ft) fieldTexts.push(ft);
				}
			}
			if (fieldTexts.length > 0) results.push(fieldTexts.join("\n"));
		}
		const extraElem = prop.extra;
		if (extraElem && typeof extraElem === "object") {
			const extra = this.convertElement(extraElem, 0);
			if (extra) results.push(extra);
		}
		return results.join("\n");
	}
	convertNote(prop) {
		const elements = prop.elements;
		if (!Array.isArray(elements) || elements.length === 0) return "";
		const texts = [];
		for (const elem of elements) {
			if (typeof elem !== "object" || elem == null) continue;
			const text = this.convertElement(elem, 0);
			if (text) texts.push(text);
		}
		if (texts.length === 0) return "";
		return `📝 ${texts.join(" ")}`;
	}
	convertLink(prop) {
		const content = prop.content || "链接";
		let url = "";
		const urlObj = prop.url;
		if (urlObj && typeof urlObj === "object") url = urlObj.url || "";
		if (url) return `[${content}](${url})`;
		return content;
	}
	convertEmoji(prop) {
		const key = prop.key || "";
		return EMOJI_MAP[key] ?? `:${key}:`;
	}
	convertLocalDatetime(prop) {
		const milliseconds = prop.milliseconds;
		const fallbackText = prop.fallbackText;
		if (milliseconds) {
			const formatted = formatMillisecondsToISO8601(milliseconds);
			if (formatted) return formatted;
		}
		return fallbackText || "";
	}
	convertList(prop) {
		const items = prop.items;
		if (!Array.isArray(items) || items.length === 0) return "";
		const lines = [];
		for (const item of items) {
			if (typeof item !== "object" || item == null) continue;
			const im = item;
			const level = im.level || 0;
			const listType = im.type || "";
			const order = im.order || 0;
			const indent = "  ".repeat(level);
			const marker = listType === "ol" ? `${Math.floor(order)}.` : "-";
			const elements = im.elements;
			if (Array.isArray(elements)) {
				const content = this.convertMarkdownElements(elements);
				lines.push(`${indent}${marker} ${content}`);
			}
		}
		return lines.join("\n");
	}
	convertBlockquote(prop) {
		let content = "";
		if (typeof prop.content === "string") content = prop.content;
		else {
			const elements = prop.elements;
			if (Array.isArray(elements)) content = this.convertMarkdownElements(elements);
		}
		if (!content) return "";
		return content.split("\n").map((line) => `> ${line}`).join("\n");
	}
	convertCodeBlock(prop) {
		const language = prop.language || "plaintext";
		let code = "";
		const contents = prop.contents;
		if (Array.isArray(contents)) for (const line of contents) {
			if (typeof line !== "object" || line == null) continue;
			const lineContents = line.contents;
			if (Array.isArray(lineContents)) for (const c of lineContents) {
				if (typeof c !== "object" || c == null) continue;
				const cm = c;
				if (typeof cm.content === "string") code += cm.content;
			}
		}
		return `\`\`\`${language}\n${code}\`\`\``;
	}
	convertCodeSpan(prop) {
		return `\`${prop.content || ""}\``;
	}
	convertHeading(prop) {
		let level = prop.level || 1;
		if (level < 1) level = 1;
		if (level > 6) level = 6;
		let content = "";
		if (typeof prop.content === "string") content = prop.content;
		else {
			const elements = prop.elements;
			if (Array.isArray(elements)) content = this.convertMarkdownElements(elements);
		}
		return `${"#".repeat(level)} ${content}`;
	}
	convertFallbackText(prop) {
		const textElem = prop.text;
		if (textElem && typeof textElem === "object") return this.extractTextContent(textElem);
		const elements = prop.elements;
		if (Array.isArray(elements)) return this.convertMarkdownElements(elements);
		return "";
	}
	convertTextTag(prop) {
		const textElem = prop.text;
		let text = "";
		if (textElem && typeof textElem === "object") text = this.extractTextContent(textElem);
		if (!text) return "";
		return `「${text}」`;
	}
	convertNumberTag(prop) {
		const textElem = prop.text;
		let text = "";
		if (textElem && typeof textElem === "object") text = this.extractTextContent(textElem);
		if (!text) return "";
		const urlObj = prop.url;
		if (urlObj && typeof urlObj === "object") {
			const url = urlObj.url;
			if (url) return `[${text}](${url})`;
		}
		return text;
	}
	convertUnknown(prop, tag) {
		if (!prop) {
			if (this.mode === MODE.Detailed) return `[未知内容](tag:${tag})`;
			return "[未知内容]";
		}
		for (const path of [
			"content",
			"text",
			"title",
			"label",
			"placeholder"
		]) if (prop[path] != null) {
			const text = this.extractTextContent(prop[path]);
			if (text) return text;
		}
		const elements = prop.elements;
		if (Array.isArray(elements) && elements.length > 0) return this.convertElements(elements, 0);
		if (this.mode === MODE.Detailed) return `[未知内容](tag:${tag})`;
		return "[未知内容]";
	}
	convertColumnSet(prop, depth) {
		const columns = prop.columns;
		if (!Array.isArray(columns) || columns.length === 0) return "";
		const results = [];
		for (const col of columns) {
			if (typeof col !== "object" || col == null) continue;
			const result = this.convertElement(col, depth + 1);
			if (result) results.push(result);
		}
		return results.join("\n\n");
	}
	convertColumn(prop, depth) {
		const elements = prop.elements;
		if (!Array.isArray(elements) || elements.length === 0) return "";
		return this.convertElements(elements, depth);
	}
	convertForm(prop, _id) {
		let out = "<form>\n";
		const elements = prop.elements;
		if (Array.isArray(elements)) out += this.convertElements(elements, 0);
		out += "\n</form>";
		return out;
	}
	convertCollapsiblePanel(prop, _id) {
		const expanded = prop.expanded === true;
		let title = "详情";
		const header = prop.header;
		if (header && typeof header === "object") {
			const titleElem = header.title;
			if (titleElem) {
				const t = this.extractTextContent(titleElem);
				if (t) title = t;
			}
		}
		if (expanded || this.mode === MODE.Detailed) {
			let out = `▼ ${title}\n`;
			const elements = prop.elements;
			if (Array.isArray(elements)) {
				const content = this.convertElements(elements, 1);
				for (const line of content.split("\n")) if (line) out += `    ${line}\n`;
			}
			out += "▲";
			return out;
		}
		return `▶ ${title}`;
	}
	convertInteractiveContainer(prop, _id) {
		let url = "";
		const actions = prop.actions;
		if (Array.isArray(actions) && actions.length > 0) {
			const action = actions[0];
			if (action && typeof action === "object") {
				if (action.type === "open_url") {
					const actionData = action.action;
					if (actionData && typeof actionData === "object") url = actionData.url || "";
				}
			}
		}
		let out = "<clickable";
		if (url) out += ` url="${escapeAttr(url)}"`;
		if (this.mode === MODE.Detailed && _id) out += ` id="${_id}"`;
		out += ">\n";
		const elements = prop.elements;
		if (Array.isArray(elements)) out += this.convertElements(elements, 0);
		out += "\n</clickable>";
		return out;
	}
	convertRepeat(prop) {
		const elements = prop.elements;
		if (Array.isArray(elements)) return this.convertElements(elements, 0);
		return "";
	}
	convertButton(prop, _id) {
		let buttonText = "";
		const textElem = prop.text;
		if (textElem && typeof textElem === "object") buttonText = this.extractTextContent(textElem);
		if (!buttonText) buttonText = "按钮";
		const disabled = prop.disabled === true;
		if (disabled && this.mode === MODE.Concise) return `[${buttonText} ✗]`;
		const actions = prop.actions;
		if (Array.isArray(actions)) for (const action of actions) {
			if (typeof action !== "object" || action == null) continue;
			const am = action;
			if (am.type === "open_url") {
				const ad = am.action;
				if (ad && typeof ad === "object") {
					const url = ad.url;
					if (url) return `[${buttonText}](${url})`;
				}
			}
		}
		if (disabled && this.mode === MODE.Detailed) {
			let result = `[${buttonText} ✗]`;
			const tips = prop.disabledTips;
			if (tips && typeof tips === "object") {
				const tipsText = this.extractTextContent(tips);
				if (tipsText) result += `(tips:"${tipsText}")`;
			}
			return result;
		}
		return `[${buttonText}]`;
	}
	convertActions(prop) {
		const actions = prop.actions;
		if (!Array.isArray(actions) || actions.length === 0) return "";
		const results = [];
		for (const action of actions) {
			if (typeof action !== "object" || action == null) continue;
			const result = this.convertElement(action, 0);
			if (result) results.push(result);
		}
		return results.join(" ");
	}
	convertSelect(prop, _id, isMulti) {
		const options = prop.options || [];
		const selectedValues = /* @__PURE__ */ new Set();
		if (isMulti) {
			const vals = prop.selectedValues;
			if (Array.isArray(vals)) {
				for (const v of vals) if (typeof v === "string") selectedValues.add(v);
			}
		} else {
			const initialOption = prop.initialOption;
			if (typeof initialOption === "string") selectedValues.add(initialOption);
			const initialIndex = prop.initialIndex;
			if (typeof initialIndex === "number" && initialIndex >= 0 && initialIndex < options.length) {
				const opt = options[initialIndex];
				if (opt && typeof opt === "object") {
					const val = opt.value;
					if (val) selectedValues.add(val);
				}
			}
		}
		const optionTexts = [];
		let hasSelected = false;
		for (const opt of options) {
			if (typeof opt !== "object" || opt == null) continue;
			const om = opt;
			let optText = "";
			const textElem = om.text;
			if (textElem && typeof textElem === "object") optText = this.extractTextContent(textElem);
			if (!optText) optText = om.value || "";
			if (!optText) continue;
			const value = om.value || "";
			if (selectedValues.has(value)) {
				optText = "✓" + optText;
				hasSelected = true;
			}
			optionTexts.push(optText);
		}
		if (optionTexts.length === 0) {
			let placeholder = "请选择";
			const phElem = prop.placeholder;
			if (phElem && typeof phElem === "object") {
				const ph = this.extractTextContent(phElem);
				if (ph) placeholder = ph;
			}
			optionTexts.push(placeholder + " ▼");
		} else if (!hasSelected) optionTexts[optionTexts.length - 1] += " ▼";
		let result = `{${optionTexts.join(" / ")}}`;
		if (this.mode === MODE.Detailed) {
			const attrs = [];
			if (isMulti) attrs.push("multi");
			if (_id.includes("person") || prop.type === "person") attrs.push("type:person");
			if (attrs.length > 0) result += `(${attrs.join(" ")})`;
		}
		return result;
	}
	convertSelectImg(prop, _id) {
		const options = prop.options;
		if (!Array.isArray(options)) return "";
		const selectedValues = /* @__PURE__ */ new Set();
		const vals = prop.selectedValues;
		if (Array.isArray(vals)) {
			for (const v of vals) if (typeof v === "string") selectedValues.add(v);
		}
		const optTexts = [];
		for (let i = 0; i < options.length; i++) {
			const opt = options[i];
			if (!opt || typeof opt !== "object") continue;
			const value = opt.value || "";
			let text = `🖼️图${i + 1}`;
			if (selectedValues.has(value)) text = "✓" + text;
			optTexts.push(text);
		}
		return `{${optTexts.join(" / ")}}`;
	}
	convertInput(prop, _id) {
		let label = "";
		const labelElem = prop.label;
		if (labelElem && typeof labelElem === "object") label = this.extractTextContent(labelElem);
		const defaultValue = prop.defaultValue || "";
		let placeholder = "";
		const phElem = prop.placeholder;
		if (phElem && typeof phElem === "object") placeholder = this.extractTextContent(phElem);
		let result;
		if (defaultValue) result = defaultValue + "___";
		else if (placeholder) result = placeholder + "_____";
		else result = "_____";
		if (label) result = label + ": " + result;
		if (prop.inputType === "multiline_text") result = result.replace(/_____/g, "...");
		return result;
	}
	convertDatePicker(prop, _id, pickerType) {
		let emoji;
		let value = "";
		switch (pickerType) {
			case "date":
				emoji = "📅";
				value = prop.initialDate || "";
				break;
			case "time":
				emoji = "🕐";
				value = prop.initialTime || "";
				break;
			case "datetime":
				emoji = "📅";
				value = prop.initialDatetime || "";
				break;
			default: emoji = "📅";
		}
		if (value) value = normalizeTimeFormat(value);
		if (!value) {
			let placeholder = "选择";
			const phElem = prop.placeholder;
			if (phElem && typeof phElem === "object") {
				const ph = this.extractTextContent(phElem);
				if (ph) placeholder = ph;
			}
			value = placeholder;
		}
		return `${emoji} ${value}`;
	}
	convertChecker(prop, _id) {
		const checkMark = prop.checked === true ? "[x]" : "[ ]";
		let text = "";
		const textElem = prop.text;
		if (textElem && typeof textElem === "object") text = this.extractTextContent(textElem);
		let result = `${checkMark} ${text}`;
		if (this.mode === MODE.Detailed && _id) result += `(id:${_id})`;
		return result;
	}
	convertOverflow(prop) {
		const options = prop.options;
		if (!Array.isArray(options) || options.length === 0) return "";
		const optTexts = [];
		for (const opt of options) {
			if (typeof opt !== "object" || opt == null) continue;
			const textElem = opt.text;
			if (textElem && typeof textElem === "object") {
				const text = this.extractTextContent(textElem);
				if (text) optTexts.push(text);
			}
		}
		return `⋮ ${optTexts.join(", ")}`;
	}
	convertPerson(prop, _id) {
		const userID = prop.userID || "";
		if (!userID) return "";
		let personName = "";
		if (this.attachment) {
			const persons = this.attachment.persons;
			if (persons && typeof persons === "object") {
				const person = persons[userID];
				if (person && typeof person === "object") {
					const content = person.content;
					if (content) personName = content;
				}
			}
		}
		if (!personName) {
			const notation = prop.notation;
			if (notation && typeof notation === "object") personName = this.extractTextContent(notation);
		}
		if (personName) {
			if (this.mode === MODE.Detailed) return `@${personName}(open_id:${userID})`;
			return `@${personName}`;
		}
		if (this.mode === MODE.Detailed) return `@用户(open_id:${userID})`;
		return `@${userID}`;
	}
	convertPersonV1(prop, _id) {
		const userID = prop.userID || "";
		if (!userID) return "";
		let personName = "";
		if (this.attachment) {
			const persons = this.attachment.persons;
			if (persons && typeof persons === "object") {
				const person = persons[userID];
				if (person && typeof person === "object") {
					const content = person.content;
					if (content) personName = content;
				}
			}
		}
		if (personName) {
			if (this.mode === MODE.Detailed) return `@${personName}(open_id:${userID})`;
			return `@${personName}`;
		}
		if (this.mode === MODE.Detailed) return `@用户(open_id:${userID})`;
		return `@${userID}`;
	}
	convertPersonList(prop) {
		const persons = prop.persons;
		if (!Array.isArray(persons) || persons.length === 0) return "";
		const names = [];
		for (const person of persons) {
			if (typeof person !== "object" || person == null) continue;
			const personID = person.id || "";
			const name = "用户";
			if (this.mode === MODE.Detailed && personID) names.push(`@${name}(id:${personID})`);
			else names.push(`@${name}`);
		}
		return names.join(", ");
	}
	convertAvatar(prop, _id) {
		const userID = prop.userID || "";
		let result = "👤";
		if (this.mode === MODE.Detailed && userID) result += `(id:${userID})`;
		return result;
	}
	convertAt(prop) {
		const userID = prop.userID || "";
		if (!userID) return "";
		let userName = "";
		let actualUserID = "";
		if (this.attachment) {
			const atUsers = this.attachment.at_users;
			if (atUsers && typeof atUsers === "object") {
				const userInfo = atUsers[userID];
				if (userInfo && typeof userInfo === "object") {
					const content = userInfo.content;
					if (content) userName = content;
					const uid = userInfo.user_id;
					if (uid) actualUserID = uid;
				}
			}
		}
		if (userName) {
			if (this.mode === MODE.Detailed) {
				if (actualUserID) return `@${userName}(user_id:${actualUserID})`;
				return `@${userName}(open_id:${userID})`;
			}
			return `@${userName}`;
		}
		if (this.mode === MODE.Detailed) {
			if (actualUserID) return `@用户(user_id:${actualUserID})`;
			return `@用户(open_id:${userID})`;
		}
		return `@${userID}`;
	}
	convertImage(prop, _id) {
		let alt = "图片";
		const altElem = prop.alt;
		if (altElem && typeof altElem === "object") {
			const altText = this.extractTextContent(altElem);
			if (altText) alt = altText;
		}
		const titleElem = prop.title;
		if (titleElem && typeof titleElem === "object") {
			const titleText = this.extractTextContent(titleElem);
			if (titleText) alt = titleText;
		}
		let result = `🖼️ ${alt}`;
		if (this.mode === MODE.Detailed) {
			const imageID = prop.imageID;
			if (imageID) {
				const token = this.getImageToken(imageID);
				if (token) result += `(img_token:${token})`;
				else result += `(img_key:${imageID})`;
			}
		}
		return result;
	}
	convertImgCombination(prop) {
		const imgList = prop.imgList;
		if (!Array.isArray(imgList) || imgList.length === 0) return "";
		let result = `🖼️ ${imgList.length}张图片`;
		if (this.mode === MODE.Detailed) {
			const keys = [];
			for (const img of imgList) {
				if (typeof img !== "object" || img == null) continue;
				const imageID = img.imageID;
				if (imageID) keys.push(imageID);
			}
			if (keys.length > 0) result += `(keys:${keys.join(",")})`;
		}
		return result;
	}
	convertChart(prop, _id) {
		let title = "图表";
		let chartType = "";
		const chartSpec = prop.chartSpec;
		if (chartSpec && typeof chartSpec === "object") {
			const titleObj = chartSpec.title;
			if (titleObj && typeof titleObj === "object") {
				const text = titleObj.text;
				if (text) title = text;
			}
			const ct = chartSpec.type;
			if (ct) {
				chartType = ct;
				const typeName = CHART_TYPE_NAMES[chartType];
				if (typeName) title = `${title}${typeName}`;
			}
		}
		const summary = this.extractChartSummary(prop, chartType);
		let result = `📊 ${title}`;
		if (summary) result += `\n数据摘要: ${summary}`;
		return result;
	}
	extractChartSummary(prop, chartType) {
		const chartSpec = prop.chartSpec;
		if (!chartSpec || typeof chartSpec !== "object") return "";
		const dataObj = chartSpec.data;
		if (!dataObj || typeof dataObj !== "object") return "";
		const values = dataObj.values;
		if (!Array.isArray(values) || values.length === 0) return "";
		switch (chartType) {
			case "line":
			case "bar":
			case "area": return this.extractLineBarSummary(chartSpec, values);
			case "pie": return this.extractPieSummary(chartSpec, values);
			default: return this.extractGenericSummary(values);
		}
	}
	extractLineBarSummary(chartSpec, values) {
		const xField = chartSpec.xField;
		const yField = chartSpec.yField;
		if (!xField || !yField || values.length === 0) return this.extractGenericSummary(values);
		const parts = [];
		for (const v of values) {
			if (typeof v !== "object" || v == null) continue;
			const vm = v;
			parts.push(`${vm[xField]}:${vm[yField]}`);
		}
		return parts.length > 0 ? parts.join(", ") : this.extractGenericSummary(values);
	}
	extractPieSummary(chartSpec, values) {
		const categoryField = chartSpec.categoryField;
		const valueField = chartSpec.valueField;
		if (!categoryField || !valueField || values.length === 0) return this.extractGenericSummary(values);
		const parts = [];
		for (const v of values) {
			if (typeof v !== "object" || v == null) continue;
			const vm = v;
			parts.push(`${vm[categoryField]}:${vm[valueField]}`);
		}
		return parts.length > 0 ? parts.join(", ") : this.extractGenericSummary(values);
	}
	extractGenericSummary(values) {
		return `${values.length}个数据点`;
	}
	convertAudio(prop, _id) {
		let result = "🎵 音频";
		if (this.mode === MODE.Detailed) {
			const fileID = prop.fileID || prop.audioID || "";
			if (fileID) result += `(key:${fileID})`;
		}
		return result;
	}
	convertVideo(prop, _id) {
		let result = "🎬 视频";
		if (this.mode === MODE.Detailed) {
			const fileID = prop.fileID || prop.videoID || "";
			if (fileID) result += `(key:${fileID})`;
		}
		return result;
	}
	convertTable(prop) {
		const columns = prop.columns;
		if (!Array.isArray(columns) || columns.length === 0) return "";
		const rows = prop.rows || [];
		const colNames = [];
		const colKeys = [];
		for (const col of columns) {
			if (typeof col !== "object" || col == null) continue;
			const cm = col;
			let displayName = cm.displayName || "";
			const name = cm.name || "";
			if (!displayName) displayName = name;
			colNames.push(displayName);
			colKeys.push(name);
		}
		const lines = [];
		lines.push("| " + colNames.join(" | ") + " |");
		lines.push("|" + colNames.map(() => "------|").join(""));
		for (const row of rows) {
			if (typeof row !== "object" || row == null) continue;
			const rm = row;
			const cells = [];
			for (const key of colKeys) {
				let cellValue = "";
				const cellData = rm[key];
				if (cellData && typeof cellData === "object") {
					if (cellData.data != null) cellValue = this.extractTableCellValue(cellData.data);
				}
				cells.push(cellValue);
			}
			lines.push("| " + cells.join(" | ") + " |");
		}
		return lines.join("\n");
	}
	extractTableCellValue(data) {
		if (typeof data === "string") return data;
		if (typeof data === "number") return data.toFixed(2);
		if (Array.isArray(data)) {
			const texts = [];
			for (const item of data) if (typeof item === "object" && item != null) {
				const im = item;
				if (typeof im.text === "string") texts.push(`「${im.text}」`);
			}
			return texts.join(" ");
		}
		if (typeof data === "object" && data != null) return this.extractTextContent(data);
		return "";
	}
	extractTextStyle(prop) {
		const style = {
			bold: false,
			italic: false,
			strikethrough: false
		};
		const textStyle = prop.textStyle;
		if (!textStyle || typeof textStyle !== "object") return style;
		const attrs = textStyle.attributes;
		if (Array.isArray(attrs)) for (const attr of attrs) {
			if (typeof attr !== "string") continue;
			switch (attr) {
				case "bold":
					style.bold = true;
					break;
				case "italic":
					style.italic = true;
					break;
				case "strikethrough":
					style.strikethrough = true;
					break;
			}
		}
		return style;
	}
	applyTextStyle(content, style) {
		if (!content) return content;
		if (style.strikethrough) content = `~~${content}~~`;
		if (style.italic) content = `*${content}*`;
		if (style.bold) content = `**${content}**`;
		return content;
	}
	getImageToken(imageID) {
		if (!this.attachment) return "";
		const images = this.attachment.images;
		if (!images || typeof images !== "object") return "";
		const imageInfo = images[imageID];
		if (!imageInfo || typeof imageInfo !== "object") return "";
		return imageInfo.token || "";
	}
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/interactive/legacy.ts
function convertLegacyCard(parsed) {
	const texts = [];
	const header = parsed.header;
	if (header) {
		const title = header.title;
		if (title && typeof title.content === "string") texts.push(`**${title.content}**`);
	}
	const body = parsed.body;
	extractTexts(parsed.elements ?? body?.elements ?? [], texts);
	return {
		content: texts.length > 0 ? texts.join("\n") : "[interactive card]",
		resources: []
	};
}
function extractTexts(elements, out) {
	if (!Array.isArray(elements)) return;
	for (const el of elements) {
		if (typeof el !== "object" || el == null) continue;
		const elem = el;
		if (elem.tag === "markdown" && typeof elem.content === "string") {
			out.push(elem.content);
			continue;
		}
		if (elem.tag === "div" || elem.tag === "plain_text" || elem.tag === "lark_md") {
			const text = elem.text;
			if (text?.content && typeof text.content === "string") out.push(text.content);
			if (typeof elem.content === "string") out.push(elem.content);
		}
		if (elem.tag === "column_set") {
			const columns = elem.columns;
			if (columns) for (const col of columns) {
				const colObj = col;
				if (colObj.elements) extractTexts(colObj.elements, out);
			}
		}
		if (elem.elements) extractTexts(elem.elements, out);
	}
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/interactive/index.ts
const convertInteractive = (raw) => {
	const parsed = safeParse(raw);
	if (!parsed) return {
		content: "[interactive card]",
		resources: []
	};
	if (typeof parsed.json_card === "string") return {
		content: new CardConverter(MODE.Concise).convert(parsed).content || "[interactive card]",
		resources: []
	};
	return convertLegacyCard(parsed);
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/share.ts
const convertShareChat = (raw) => {
	return {
		content: `<group_card id="${safeParse(raw)?.chat_id ?? ""}"/>`,
		resources: []
	};
};
const convertShareUser = (raw) => {
	return {
		content: `<contact_card id="${safeParse(raw)?.user_id ?? ""}"/>`,
		resources: []
	};
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/location.ts
const convertLocation = (raw) => {
	const parsed = safeParse(raw);
	const name = parsed?.name ?? "";
	const lat = parsed?.latitude ?? "";
	const lng = parsed?.longitude ?? "";
	return {
		content: `<location${name ? ` name="${name}"` : ""}${lat && lng ? ` coords="lat:${lat},lng:${lng}"` : ""}/>`,
		resources: []
	};
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/merge-forward.ts
/**
* Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
* SPDX-License-Identifier: MIT
*
* Converter for "merge_forward" message type.
*
* Unlike other converters this is async — it fetches sub-messages via
* the Feishu IM API and recursively expands nested merge_forward messages.
*
* The API returns ALL nested sub-messages in a single flat `items`
* array with `upper_message_id` pointing to the parent container.
* We build a tree from this flat list and recursively format it —
* only one API call is needed regardless of nesting depth.
*
* This module is a pure "data → format" converter: all API capabilities
* (`fetchSubMessages`, `batchResolveNames`, `resolveUserName`) are
* injected via callbacks in `ConvertContext`. Callers are responsible
* for creating the appropriate callbacks (UAT / TAT / event push).
*/
const log = larkLogger$1("converters/merge-forward");
/**
* Recursively expand a merge_forward message.
*
* Output format aligns with the Go reference implementation:
* ```
* <forwarded_messages>
* [RFC3339] sender_id:
*     message content
* </forwarded_messages>
* ```
*/
const convertMergeForward = async (_raw, ctx) => {
	const { accountId, messageId, resolveUserName, batchResolveNames, fetchSubMessages, convertMessageContent } = ctx;
	if (!fetchSubMessages) return {
		content: "<forwarded_messages/>",
		resources: []
	};
	return {
		content: await expand(accountId, messageId, resolveUserName, batchResolveNames, fetchSubMessages, convertMessageContent),
		resources: []
	};
};
async function expand(accountId, messageId, resolveUserName, batchResolveNames, fetchSubMessages, convertContent) {
	let items;
	try {
		items = await fetchSubMessages(messageId);
	} catch (error) {
		log.error("fetch sub-messages failed", {
			messageId,
			error: error instanceof Error ? error.message : String(error)
		});
		return "<forwarded_messages/>";
	}
	if (items.length === 0) return "<forwarded_messages/>";
	const childrenMap = buildChildrenMap(items, messageId);
	const senderIds = collectSenderIds(items, messageId);
	if (senderIds.length > 0 && batchResolveNames) try {
		await batchResolveNames(senderIds);
	} catch (err) {
		log.debug("batchResolveNames failed (best-effort)", { error: err instanceof Error ? err.message : String(err) });
	}
	return formatSubTree(messageId, childrenMap, accountId, resolveUserName, convertContent);
}
/**
* Build a map from parent message ID → ordered child items.
*
* The API returns a flat `items` array where each item may carry an
* `upper_message_id` pointing to its parent container. Items without
* `upper_message_id` are direct children of the root container.
*
* The root container message itself (matching `rootMessageId`) is skipped.
*/
function buildChildrenMap(items, rootMessageId) {
	const map = /* @__PURE__ */ new Map();
	for (const item of items) {
		if (item.message_id === rootMessageId && !item.upper_message_id) continue;
		const parentId = item.upper_message_id ?? rootMessageId;
		let children = map.get(parentId);
		if (!children) {
			children = [];
			map.set(parentId, children);
		}
		children.push(item);
	}
	for (const children of map.values()) children.sort((a, b) => {
		return parseInt(String(a.create_time ?? "0"), 10) - parseInt(String(b.create_time ?? "0"), 10);
	});
	return map;
}
/**
* Collect all unique sender IDs from non-root items for batch name resolution.
*/
function collectSenderIds(items, rootMessageId) {
	const ids = /* @__PURE__ */ new Set();
	for (const item of items) {
		if (item.message_id === rootMessageId && !item.upper_message_id) continue;
		if (item.sender?.sender_type === "user") {
			const senderId = item.sender.id;
			if (senderId) ids.add(senderId);
		}
	}
	return [...ids];
}
/**
* Recursively format a sub-tree of messages rooted at `parentId`.
*
* For `merge_forward` children this recurses into `formatSubTree`
* directly (no additional API calls). For other message types it
* delegates to `convertMessageContent`.
*/
async function formatSubTree(parentId, childrenMap, accountId, resolveUserName, convertContent) {
	const children = childrenMap.get(parentId);
	if (!children || children.length === 0) return "<forwarded_messages/>";
	const parts = [];
	for (const item of children) try {
		const msgType = item.msg_type ?? "text";
		const senderId = item.sender?.id ?? "unknown";
		const createTime = item.create_time ? parseInt(String(item.create_time), 10) : void 0;
		const timestamp = createTime ? formatTimestamp(createTime) : "unknown";
		const rawContent = item.body?.content ?? "{}";
		let content;
		if (msgType === "merge_forward") {
			const nestedId = item.message_id;
			if (nestedId) content = await formatSubTree(nestedId, childrenMap, accountId, resolveUserName, convertContent);
			else content = "<forwarded_messages/>";
		} else {
			const subCtx = {
				...buildConvertContextFromItem(item, parentId, accountId),
				accountId,
				resolveUserName,
				convertMessageContent: convertContent
			};
			if (!convertContent) content = rawContent;
			else content = (await convertContent(rawContent, msgType, subCtx)).content;
		}
		const displayName = resolveUserName?.(senderId) ?? senderId;
		const indented = indentLines(content, "    ");
		parts.push(`[${timestamp}] ${displayName}:\n${indented}`);
	} catch (err) {
		log.warn("failed to convert sub-message", {
			messageId: item.message_id,
			msgType: item.msg_type ?? "unknown",
			error: err instanceof Error ? err.message : String(err)
		});
	}
	if (parts.length === 0) return "<forwarded_messages/>";
	return `<forwarded_messages>\n${parts.join("\n")}\n</forwarded_messages>`;
}
/**
* Convert a millisecond timestamp to RFC 3339 format with +08:00 offset
* (Beijing time).
*/
function formatTimestamp(ms) {
	const date = new Date(ms);
	const utcMs = date.getTime() + date.getTimezoneOffset() * 6e4;
	const bjDate = new Date(utcMs + 8 * 36e5);
	return `${bjDate.getFullYear()}-${String(bjDate.getMonth() + 1).padStart(2, "0")}-${String(bjDate.getDate()).padStart(2, "0")}T${String(bjDate.getHours()).padStart(2, "0")}:${String(bjDate.getMinutes()).padStart(2, "0")}:${String(bjDate.getSeconds()).padStart(2, "0")}+08:00`;
}
/** Add a prefix indent to every line of text. */
function indentLines(text, indent) {
	return text.split("\n").map((line) => `${indent}${line}`).join("\n");
}
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/folder.ts
const convertFolder = (raw) => {
	const parsed = safeParse(raw);
	const fileKey = parsed?.file_key;
	if (!fileKey) return {
		content: "[folder]",
		resources: []
	};
	const fileName = parsed?.file_name ?? "";
	return {
		content: `<folder key="${fileKey}"${fileName ? ` name="${fileName}"` : ""}/>`,
		resources: []
	};
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/system.ts
const convertSystem = (raw) => {
	const parsed = safeParse(raw);
	if (!parsed?.template) return {
		content: "[system message]",
		resources: []
	};
	let content = parsed.template;
	const replacements = {
		"{from_user}": parsed.from_user?.length ? parsed.from_user.filter(Boolean).join(", ") : void 0,
		"{to_chatters}": parsed.to_chatters?.length ? parsed.to_chatters.filter(Boolean).join(", ") : void 0,
		"{divider_text}": parsed.divider_text?.text
	};
	for (const [placeholder, value] of Object.entries(replacements)) if (value != null) content = content.replaceAll(placeholder, value);
	else content = content.replaceAll(placeholder, "");
	return {
		content: content.trim(),
		resources: []
	};
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/hongbao.ts
const convertHongbao = (raw) => {
	const text = safeParse(raw)?.text;
	return {
		content: `<hongbao${text ? ` text="${text}"` : ""}/>`,
		resources: []
	};
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/calendar.ts
function formatCalendarContent(parsed) {
	const summary = parsed?.summary ?? "";
	const parts = [];
	if (summary) parts.push(`📅 ${summary}`);
	const start = parsed?.start_time ? millisToDatetime(parsed.start_time) : "";
	const end = parsed?.end_time ? millisToDatetime(parsed.end_time) : "";
	if (start && end) parts.push(`🕙 ${start} ~ ${end}`);
	else if (start) parts.push(`🕙 ${start}`);
	return parts.join("\n") || "[calendar event]";
}
const convertShareCalendarEvent = (raw) => {
	return {
		content: `<calendar_share>${formatCalendarContent(safeParse(raw))}</calendar_share>`,
		resources: []
	};
};
const convertCalendar = (raw) => {
	return {
		content: `<calendar_invite>${formatCalendarContent(safeParse(raw))}</calendar_invite>`,
		resources: []
	};
};
const convertGeneralCalendar = (raw) => {
	return {
		content: `<calendar>${formatCalendarContent(safeParse(raw))}</calendar>`,
		resources: []
	};
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/video-chat.ts
const convertVideoChat = (raw) => {
	const parsed = safeParse(raw);
	const topic = parsed?.topic ?? "";
	const meetingNo = parsed?.meet_number?.trim() ?? "";
	const parts = [];
	if (topic) parts.push(`Topic: ${topic}`);
	if (parsed?.start_time) parts.push(`Start time: ${millisToDatetime(parsed.start_time)}`);
	if (meetingNo) parts.push(`Meeting number: ${meetingNo}`);
	return {
		content: `<meeting>${parts.join("\n") || "[video chat]"}</meeting>`,
		resources: []
	};
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/todo.ts
/** Extract plain text from post-style content blocks. */
function extractPlainText(content) {
	const lines = [];
	for (const paragraph of content) {
		if (!Array.isArray(paragraph)) continue;
		let line = "";
		for (const el of paragraph) if (el.text) line += el.text;
		lines.push(line);
	}
	return lines.join("\n").trim();
}
const convertTodo = (raw) => {
	const parsed = safeParse(raw);
	const parts = [];
	const fullTitle = [parsed?.summary?.title ?? "", parsed?.summary?.content ? extractPlainText(parsed.summary.content) : ""].filter(Boolean).join("\n");
	if (fullTitle) parts.push(fullTitle);
	if (parsed?.due_time) parts.push(`Due: ${millisToDatetime(parsed.due_time)}`);
	return {
		content: `<todo>\n${parts.join("\n") || "[todo]"}\n</todo>`,
		resources: []
	};
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/vote.ts
const convertVote = (raw) => {
	const parsed = safeParse(raw);
	const topic = parsed?.topic ?? "";
	const options = parsed?.options ?? [];
	const parts = [];
	if (topic) parts.push(topic);
	for (const opt of options) parts.push(`• ${opt}`);
	return {
		content: `<vote>\n${parts.join("\n") || "[vote]"}\n</vote>`,
		resources: []
	};
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/unknown.ts
const convertUnknown = (raw) => {
	const parsed = safeParse(raw);
	if (parsed != null && typeof parsed === "object" && "text" in parsed) {
		const text = parsed.text;
		if (typeof text === "string") return {
			content: text,
			resources: []
		};
	}
	return {
		content: "[unsupported message]",
		resources: []
	};
};
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/index.ts
const converters = new Map([
	["text", convertText],
	["post", convertPost],
	["image", convertImage],
	["file", convertFile],
	["audio", convertAudio],
	["video", convertVideo],
	["media", convertVideo],
	["sticker", convertSticker],
	["interactive", convertInteractive],
	["share_chat", convertShareChat],
	["share_user", convertShareUser],
	["location", convertLocation],
	["merge_forward", convertMergeForward],
	["folder", convertFolder],
	["system", convertSystem],
	["hongbao", convertHongbao],
	["share_calendar_event", convertShareCalendarEvent],
	["calendar", convertCalendar],
	["general_calendar", convertGeneralCalendar],
	["video_chat", convertVideoChat],
	["todo", convertTodo],
	["vote", convertVote],
	["unknown", convertUnknown]
]);
//#endregion
//#region ../../../../dsh/home/dsh-management/dsh-plugins/plugins/feishu-channel/vendor/openclaw-lark/src/messaging/converters/content-converter.ts
/**
* Convert raw message content using the converter for the given message
* type. Falls back to the "unknown" converter for unrecognised types.
*
* Returns a Promise because some converters (e.g. merge_forward) perform
* async operations. Synchronous converters are awaited transparently.
*/
async function convertMessageContent(raw, messageType, ctx) {
	const fn = converters.get(messageType) ?? converters.get("unknown");
	if (!fn) return {
		content: raw,
		resources: []
	};
	return fn(raw, ctx.convertMessageContent ? ctx : {
		...ctx,
		convertMessageContent
	});
}
//#endregion
export { LarkClient, OfficialTurnStream, bindTerminalTables, convertMessageContent, setLoggerProvider, startToolUseTraceRun };

//# sourceMappingURL=official-stream.js.map