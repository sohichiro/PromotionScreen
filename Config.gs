/**
 * =========================
 * 設定管理
 * =========================
 * 
 * このファイルには、アプリケーション全体で使用する設定が含まれています。
 * 
 * スクリプトプロパティの設定方法:
 * 1. Google Apps Scriptエディタで「プロジェクトの設定」→「スクリプト プロパティ」を開く
 * 2. 以下のプロパティを追加:
 * 
 * === 必須設定 ===
 * - INBOX_FOLDER_ID: 受信箱フォルダのID（アップロードされたファイルが保存される場所）
 * - OK_FOLDER_ID: OKフォルダのID（承認されたファイルが移動される場所）
 * - NG_FOLDER_ID: NGフォルダのID（非承認されたファイルが移動される場所）
 * 
 * === Slack設定（オプション） ===
 * - SLACK_BOT_TOKEN: Slack Bot Token（Slack通知を有効にする場合）
 * - SLACK_SIGNING_SECRET: Slack Signing Secret（Slack Interactivityの署名検証用）
 * - SLACK_CHANNEL_ID: SlackチャンネルID（通知を送信するチャンネル）
 * 
 * === サイネージ設定（オプション） ===
 * - SIGNAGE_FOLDER_ID: サイネージ表示用フォルダのID（未設定の場合はOK_FOLDER_IDを使用）
 * 
 * === その他の設定（オプション） ===
 * - SHARED_SECRET: サイネージAPIの署名用シークレット（デフォルト: "TEMP_SECRET"）
 * - AUDIT_SHEET_ID: 監査ログ用スプレッドシートID
 * - DEBUG_SHEET_ID: デバッグログ用スプレッドシートID
 * - DEBUG_MODE: デバッグモード（"true"の場合のみスプレッドシートにログを書き込む）
 */

/**
 * アプリケーション設定
 * スクリプトプロパティから値を取得し、デフォルト値を設定します。
 */
const CONFIG = {
  // ===== Google Drive フォルダ設定 =====
  inboxFolderId: PropertiesService.getScriptProperties().getProperty("INBOX_FOLDER_ID") || "",
  okFolderId: PropertiesService.getScriptProperties().getProperty("OK_FOLDER_ID") || "",
  ngFolderId: PropertiesService.getScriptProperties().getProperty("NG_FOLDER_ID") || "",
  
  // ===== Slack設定 =====
  slackBotToken: PropertiesService.getScriptProperties().getProperty("SLACK_BOT_TOKEN") || "",
  slackSigningSecret: PropertiesService.getScriptProperties().getProperty("SLACK_SIGNING_SECRET") || "",
  slackChannelId: PropertiesService.getScriptProperties().getProperty("SLACK_CHANNEL_ID") || "",
  
  // ===== サイネージ設定（表示用） =====
  signageFolderId: PropertiesService.getScriptProperties().getProperty("SIGNAGE_FOLDER_ID") || "", // 未設定の場合はokFolderIdを使用
  signageExpiresMs: 24 * 60 * 60 * 1000, // 24時間（ミリ秒）
  signageAllowOrigin: '*', // CORS設定
  
  // ===== その他の設定 =====
  sharedSecret: PropertiesService.getScriptProperties().getProperty("SHARED_SECRET") || "TEMP_SECRET",
  auditSheetId: PropertiesService.getScriptProperties().getProperty("AUDIT_SHEET_ID") || "",
  debugMode: PropertiesService.getScriptProperties().getProperty("DEBUG_MODE") === "true",
  debugSheetId: PropertiesService.getScriptProperties().getProperty("DEBUG_SHEET_ID") || "",
};

/**
 * 設定の検証
 * 必須設定が正しく設定されているか確認します。
 * @returns {Object} 検証結果 { valid: boolean, errors: string[] }
 */
function validateConfig() {
  const errors = [];
  
  if (!CONFIG.inboxFolderId) {
    errors.push("INBOX_FOLDER_ID が設定されていません");
  }
  if (!CONFIG.okFolderId) {
    errors.push("OK_FOLDER_ID が設定されていません");
  }
  if (!CONFIG.ngFolderId) {
    errors.push("NG_FOLDER_ID が設定されていません");
  }
  
  return {
    valid: errors.length === 0,
    errors: errors
  };
}

