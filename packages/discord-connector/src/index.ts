export const DISCORD_APPLICATION_ID = "1537317765558304838";
export const DISCORD_PUBLIC_KEY = "776cd97855a80999f08692fb0b2f7bdb52f54a170823e681e88530baa815e70f";
export const DISCORD_GUILD_PERMISSION_INTEGER = "19456";

export type DiscordCommandPolicy = "approved-only" | "owner-any" | "dm-only";
export type DiscordDisplayPolicy = "metadata-only" | "full-preview";

export type DiscordInteraction = {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  context?: number;
  member?: { user?: DiscordUser };
  user?: DiscordUser;
  data?: {
    id?: string;
    name?: string;
    custom_id?: string;
    options?: DiscordCommandOption[];
  };
};

export type DiscordUser = {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
};

export type DiscordCommandOption = {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordCommandOption[];
};

export type DiscordAssistantRequest = {
  interactionId: string;
  discordUserId: string;
  displayName?: string;
  commandName: string;
  options: Record<string, string | number | boolean>;
  guildId?: string;
  channelId?: string;
  componentId?: string;
};

export type DiscordAssistantResponse = {
  content: string;
  ephemeral?: boolean;
  components?: unknown[];
};

const hexBytes = (value: string): Uint8Array | undefined => {
  if (!/^[0-9a-f]+$/iu.test(value) || value.length % 2 !== 0) return undefined;
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
};

const constantTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
};

export const verifyDiscordInteraction = async (input: {
  publicKeyHex: string;
  signatureHex: string;
  timestamp: string;
  body: Uint8Array;
  now?: Date;
  maxClockSkewSeconds?: number;
}): Promise<boolean> => {
  const publicKey = hexBytes(input.publicKeyHex);
  const signature = hexBytes(input.signatureHex);
  if (!publicKey || publicKey.length !== 32 || !signature || signature.length !== 64) return false;
  const unixSeconds = Number(input.timestamp);
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  if (!Number.isSafeInteger(unixSeconds) ||
    Math.abs(nowSeconds - unixSeconds) > (input.maxClockSkewSeconds ?? 300)) return false;
  const timestamp = new TextEncoder().encode(input.timestamp);
  const signed = new Uint8Array(timestamp.length + input.body.length);
  signed.set(timestamp);
  signed.set(input.body, timestamp.length);
  try {
    const key = await crypto.subtle.importKey("raw", new Uint8Array(publicKey).buffer,
      { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key,
      new Uint8Array(signature).buffer, new Uint8Array(signed).buffer);
  } catch {
    return false;
  }
};

const hmacBytes = async (key: string, value: string): Promise<Uint8Array> => {
  const imported = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(value)));
};

export const createBridgeSignature = async (input: {
  signingKey: string;
  timestamp: string;
  nonce: string;
  bodyDigest: string;
}): Promise<string> => Array.from(await hmacBytes(input.signingKey,
  `${input.timestamp}.${input.nonce}.${input.bodyDigest}`))
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const verifyBridgeSignature = async (input: {
  signingKey: string;
  timestamp: string;
  nonce: string;
  bodyDigest: string;
  signatureHex: string;
  now?: Date;
  maxClockSkewSeconds?: number;
}): Promise<boolean> => {
  const unixSeconds = Number(input.timestamp);
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  const supplied = hexBytes(input.signatureHex);
  if (!supplied || !Number.isSafeInteger(unixSeconds) ||
    Math.abs(nowSeconds - unixSeconds) > (input.maxClockSkewSeconds ?? 300)) return false;
  const expected = await hmacBytes(input.signingKey,
    `${input.timestamp}.${input.nonce}.${input.bodyDigest}`);
  return constantTimeEqual(supplied, expected);
};

export const flattenCommandOptions = (
  options: readonly DiscordCommandOption[] = [],
): Record<string, string | number | boolean> => {
  const flattened: Record<string, string | number | boolean> = {};
  const visit = (items: readonly DiscordCommandOption[]) => {
    for (const item of items) {
      if (item.value !== undefined) flattened[item.name] = item.value;
      if (item.options) {
        flattened["subcommand"] ??= item.name;
        visit(item.options);
      }
    }
  };
  visit(options);
  return flattened;
};

const localized = (english: string, japanese: string) => ({
  description: english,
  description_localizations: { ja: japanese },
});

const repeatChoices = [
  { name: "Daily", name_localizations: { ja: "毎日" }, value: "daily" },
  { name: "Selected weekdays", name_localizations: { ja: "曜日指定" }, value: "weekly" },
  { name: "Monthly", name_localizations: { ja: "毎月" }, value: "monthly" },
] as const;

const taskContentOptions = [
  { type: 3, name: "title", ...localized("Task title", "タスク名"), required: true, max_length: 500 },
  { type: 3, name: "description", ...localized("Task details", "タスク内容"), required: true, max_length: 4_000 },
] as const;

const taskRecurringOptions = [
  ...taskContentOptions,
  { type: 3, name: "frequency", ...localized("Recurrence", "繰り返し"), choices: repeatChoices, required: true },
  { type: 3, name: "time", ...localized("Local time in HH:mm format", "実行時刻（HH:mm）"), required: true },
  { type: 5, name: "sunday", ...localized("Run on Sunday", "日曜日に実行") },
  { type: 5, name: "monday", ...localized("Run on Monday", "月曜日に実行") },
  { type: 5, name: "tuesday", ...localized("Run on Tuesday", "火曜日に実行") },
  { type: 5, name: "wednesday", ...localized("Run on Wednesday", "水曜日に実行") },
  { type: 5, name: "thursday", ...localized("Run on Thursday", "木曜日に実行") },
  { type: 5, name: "friday", ...localized("Run on Friday", "金曜日に実行") },
  { type: 5, name: "saturday", ...localized("Run on Saturday", "土曜日に実行") },
  { type: 4, name: "day-of-month", ...localized("Day of month from 1 to 31", "毎月の日付（1〜31）"), min_value: 1, max_value: 31 },
] as const;

export const discordCommandManifest = [
  { name: "link", ...localized("Link this Discord user to the owner workspace", "所有者ワークスペースへ接続します"),
    integration_types: [1], contexts: [1], options: [{ type: 3, name: "code",
      ...localized("One-time link code", "一回限りのリンクコード"), required: true }] },
  { name: "agent", ...localized("Talk with the personal agent", "個人エージェントとチャットします"),
    integration_types: [0, 1], contexts: [0, 1, 2], options: [{ type: 3, name: "message",
      ...localized("Message to the agent", "エージェントへのメッセージ"), required: true, max_length: 6_000 }] },
  { name: "tasks", ...localized("Manage agent tasks", "エージェントのタスクを管理します"),
    integration_types: [0, 1], contexts: [0, 1, 2], options: [
      { type: 1, name: "list", ...localized("List tasks", "タスクを一覧表示します") },
      { type: 1, name: "once", ...localized("Create a task that runs once", "一回実行するタスクを作成します"), options: [
        ...taskContentOptions,
        { type: 3, name: "time", ...localized("Local time in HH:mm format", "実行時刻（HH:mm）"), required: true },
        { type: 3, name: "date", ...localized("Optional YYYY-MM-DD date; defaults to the next occurrence", "日付（YYYY-MM-DD、省略時は次の実行時刻）") },
      ] },
      { type: 1, name: "repeat", ...localized("Create a recurring task", "繰り返しタスクを作成します"), options: [
        ...taskRecurringOptions,
      ] },
      { type: 1, name: "update", ...localized("Update a task", "タスクを更新します"), options: [
        { type: 3, name: "task", ...localized("Task ID", "タスクID"), required: true },
        { type: 3, name: "title", ...localized("New title", "新しいタスク名") },
        { type: 3, name: "description", ...localized("New details", "新しいタスク内容") },
        { type: 3, name: "status", ...localized("pending, in-progress, or completed", "pending、in-progress、completedのいずれか") },
      ] },
      { type: 1, name: "unschedule", ...localized("Disable an existing task schedule", "既存タスクの予定実行を解除します"), options: [
        { type: 3, name: "task", ...localized("Task ID from /tasks list", "/tasks listで確認したタスクID"), required: true },
      ] },
      { type: 1, name: "delete", ...localized("Delete a task", "タスクを削除します"), options: [
        { type: 3, name: "task", ...localized("Task ID", "タスクID"), required: true },
      ] },
    ] },
  { name: "approvals", ...localized("Review pending approvals", "承認待ちを確認します"), integration_types: [0, 1], contexts: [0, 1, 2] },
  { name: "audit", ...localized("Show recent audit metadata", "最近の監査メタデータを表示します"), integration_types: [0, 1], contexts: [0, 1, 2] },
  { name: "notify-here", ...localized("Request this channel as a notification destination", "このチャンネルを通知先として申請します"), integration_types: [0], contexts: [0] },
  { name: "notify-off-here", ...localized("Disable notifications in this channel", "このチャンネルへの通知を解除します"), integration_types: [0], contexts: [0] },
  { name: "unlink", ...localized("Disconnect this Discord user", "Discord接続を解除します"), integration_types: [0, 1], contexts: [0, 1, 2] },
  { name: "status", ...localized("Show connector status", "接続状態を表示します"), integration_types: [0, 1], contexts: [0, 1, 2] },
  { name: "timezone", ...localized("Manage the owner time zone", "Ownerタイムゾーンを管理します"),
    integration_types: [0, 1], contexts: [0, 1, 2], options: [
      { type: 1, name: "show", ...localized("Show the current time zone", "現在のタイムゾーンを表示します") },
      { type: 1, name: "set", ...localized("Set the owner time zone", "Ownerタイムゾーンを設定します"), options: [
        { type: 3, name: "value", ...localized("IANA time zone such as Asia/Tokyo", "Asia/TokyoなどのIANAタイムゾーン"), required: true },
      ] },
    ] },
] as const;

export const discordInstallUrls = (applicationId: string) => ({
  user: `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&scope=applications.commands&integration_type=1`,
  guild: `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&scope=applications.commands%20bot&permissions=${DISCORD_GUILD_PERMISSION_INTEGER}&integration_type=0`,
});
