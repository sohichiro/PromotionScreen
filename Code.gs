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
  queueSheetId: PropertiesService.getScriptProperties().getProperty("QUEUE_SHEET_ID") || "", // NG処理キュー用スプレッドシートID
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

// =========================
// メイン処理
// =========================

const META_KEYS = {
  comment: "comment",
  uploadedAt: "uploadedAt",
  status: "status",
};

const STATUS = {
  pending: "PENDING",
  approved: "OK",
  rejected: "NG",
};

function doPost(event) {
  // 最初に必ずログを出力（doPost が呼ばれているか確認）
  paperLog("[doPost] 関数が呼ばれました", new Date().toISOString());
  
  try {
    if (CONFIG.debugMode) {
      paperLog("[doPost] リクエスト受信", "contentType=" + (event?.postData?.type || "なし"), "hasPostData=" + !!event?.postData);
      paperLog("[doPost] CONFIG確認", "slackBotToken=" + (CONFIG.slackBotToken ? "設定済み(" + CONFIG.slackBotToken.substring(0, 10) + "...)" : "未設定"), "slackChannelId=" + (CONFIG.slackChannelId || "未設定"));
    }
    
    // Slack Interactivity リクエストかどうかを判定
    const contentType = event?.postData?.type || "";
    const isSlackRequest = contentType === "application/x-www-form-urlencoded" && event?.parameter?.payload;
    
    if (isSlackRequest) {
      if (CONFIG.debugMode) {
        paperLog("[doPost] Slack Interactivity リクエストとして処理");
      }
      return handleSlackInteractivity(event);
    }

    // リクエストボディを解析
    if (!event?.postData?.contents) {
      paperLog("[doPost] エラー: リクエストデータが空");
      return buildErrorResponse("リクエストデータが空です。", 400);
    }

    const payload = JSON.parse(event.postData.contents);
    
    // 非同期NG処理リクエストの場合
    if (payload.action === "processNG") {
      if (CONFIG.debugMode) {
        paperLog("[doPost] 非同期NG処理リクエストとして処理");
      }
      return handleAsyncNGProcessing(payload);
    }

    // 画像アップロード処理
    if (CONFIG.debugMode) {
      paperLog("[doPost] 画像アップロード処理を開始");
    }
    if (CONFIG.debugMode) {
      paperLog("[doPost] ペイロード解析完了", "filename=" + (payload.filename || "なし"), "hasPhotoBase64=" + !!payload.photoBase64);
    }
    
    validatePayload(payload);

    const folder = DriveApp.getFolderById(CONFIG.inboxFolderId);
    const filename = buildFileName(payload);
    if (CONFIG.debugMode) {
      paperLog("[doPost] ファイル作成開始", "filename=" + filename, "folderId=" + CONFIG.inboxFolderId);
    }
    
    const blob = createBlob(payload, filename);
    const file = folder.createFile(blob);
    
    // メタデータをファイルの説明に JSON 形式で保存
    const metadata = {
      comment: payload.comment || "",
      email: payload.email || "",
      uploadedAt: payload.timestamp || new Date().toISOString(),
      status: STATUS.pending,
    };
    // メールアドレスがある場合はJSON形式で保存、ない場合はコメントのみ
    const description = payload.email 
      ? JSON.stringify(metadata)
      : (payload.comment || "");
    file.setDescription(description);
    file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.VIEW);
    
    // setProperty は使えないため、メタデータはファイル名や説明に含める
    // 必要に応じて、後で Drive API v3 を使ってプロパティを設定することも可能
    if (CONFIG.debugMode) {
      paperLog("[doPost] ファイル作成完了", "fileId=" + file.getId(), "fileName=" + file.getName(), "metadata=" + JSON.stringify(metadata));
      paperLog("[doPost] Slack通知を開始");
    }

    notifySlack(file, payload);

    if (CONFIG.debugMode) {
      paperLog("[doPost] 処理完了", "fileId=" + file.getId());
    }
    return buildJsonResponse({ ok: true, fileId: file.getId(), id: file.getId() });
  } catch (err) {
    paperLog("[ERROR] [doPost] エラー発生", "error=" + String(err), "stack=" + (err.stack || "なし"));
    return buildErrorResponse(err.message || "不明なエラーが発生しました。");
  }
}

function validatePayload(payload) {
  if (!payload) {
    throw new Error("JSON ボディが解析できません。");
  }
  if (!payload.photoBase64) {
    throw new Error("画像データが含まれていません。");
  }
  if (!payload.mimeType) {
    throw new Error("MIME タイプが指定されていません。");
  }
  if (!payload.filename) {
    throw new Error("ファイル名が指定されていません。");
  }
}

function createBlob(payload, filename) {
  let binary;

  try {
    binary = Utilities.base64Decode(payload.photoBase64);
  } catch (err) {
    throw new Error("画像データのデコードに失敗しました。");
  }

  return Utilities.newBlob(binary, payload.mimeType, filename);
}

function buildFileName(payload) {
  const time = payload.timestamp ? new Date(payload.timestamp) : new Date();
  const iso = Utilities.formatDate(time, Session.getScriptTimeZone(), "yyyyMMdd-HHmmss");
  const safeName = payload.filename.replace(/[^\w.\-]/g, "_");
  return `${iso}-${safeName}`;
}

function notifySlack(file, payload) {
  paperLog("[notifySlack] 関数が呼ばれました", "fileId=" + file.getId(), "fileName=" + file.getName());
  
  // Bot Token が設定されている場合は Block Kit 形式で投稿
  if (CONFIG.slackBotToken && CONFIG.slackChannelId) {
    paperLog("[notifySlack] Block Kit 形式で投稿を試みます", "botToken設定=" + !!CONFIG.slackBotToken, "channelId=" + CONFIG.slackChannelId);
    postPhotoToSlackWithBlockKit(file, payload);
    return;
  }

  // Bot Token が未設定の場合はスキップ
  if (CONFIG.debugMode) {
    paperLog("[notifySlack] Bot Token が未設定のため、Slack通知をスキップします");
  }
}

function postPhotoToSlackWithBlockKit(file, payload) {
  paperLog("[postPhotoToSlackWithBlockKit] 関数が呼ばれました", "fileId=" + file.getId(), "fileName=" + file.getName());
  
  const fileUrl = `https://drive.google.com/file/d/${file.getId()}/view`;
  const comment = payload.comment || "（なし）";
  
  paperLog("[postPhotoToSlackWithBlockKit] リクエスト準備", "channelId=" + CONFIG.slackChannelId, "botToken=" + (CONFIG.slackBotToken ? "設定済み" : "未設定"));
  
  // ステップ1: アップロードURLを取得
  paperLog("[postPhotoToSlackWithBlockKit] アップロードURL取得開始");
  
  const blob = file.getBlob();
  const fileSize = blob.getBytes().length;
  
  const getUploadUrl = "https://slack.com/api/files.getUploadURLExternal" +
    "?filename=" + encodeURIComponent(file.getName()) +
    "&length=" + fileSize;
  
  const urlResp = UrlFetchApp.fetch(getUploadUrl, {
    method: "post",
    headers: {
      "Authorization": "Bearer " + CONFIG.slackBotToken
    },
    muteHttpExceptions: true,
  });

  const urlData = JSON.parse(urlResp.getContentText() || "{}");
  if (!urlData.ok) {
    paperLog("[ERROR] [postPhotoToSlackWithBlockKit] URL取得エラー", "error=" + urlResp.getContentText());
    return;
  }

  paperLog("[postPhotoToSlackWithBlockKit] URL取得成功");

  // ステップ2: 画像をアップロード
  paperLog("[postPhotoToSlackWithBlockKit] 画像アップロード開始");
  
  const uploadResp = UrlFetchApp.fetch(urlData.upload_url, {
    method: "post",
    payload: blob,
    muteHttpExceptions: true,
  });

  const uploadCode = uploadResp.getResponseCode();
  if (uploadCode < 200 || uploadCode >= 300) {
    paperLog("[ERROR] [postPhotoToSlackWithBlockKit] 画像アップロードエラー", "statusCode=" + uploadCode);
    return;
  }

  paperLog("[postPhotoToSlackWithBlockKit] 画像アップロード成功");

  // ステップ3: アップロード完了を通知（チャンネルに投稿）
  paperLog("[postPhotoToSlackWithBlockKit] アップロード完了通知開始");
  
  const completeResp = UrlFetchApp.fetch("https://slack.com/api/files.completeUploadExternal", {
    method: "post",
    headers: {
      "Authorization": "Bearer " + CONFIG.slackBotToken
    },
    contentType: "application/json",
    payload: JSON.stringify({
      files: [{
        id: urlData.file_id,
        title: file.getName()
      }],
      channel_id: CONFIG.slackChannelId,
      initial_comment: `*${escapeMrkdwn(file.getName())}*\n${new Date().toLocaleString("ja-JP")}\nコメント: ${escapeMrkdwn(comment)}\n<${fileUrl}|📷 Driveで画像を開く>`
    }),
    muteHttpExceptions: true,
  });

  const completeData = JSON.parse(completeResp.getContentText() || "{}");
  if (!completeData.ok) {
    paperLog("[ERROR] [postPhotoToSlackWithBlockKit] アップロード完了通知エラー", "error=" + completeResp.getContentText());
    return;
  }

  paperLog("[postPhotoToSlackWithBlockKit] アップロード完了");

  // ステップ4: ボタン付きメッセージを画像の直後に投稿
  paperLog("[postPhotoToSlackWithBlockKit] ボタンメッセージ投稿開始");
  
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `────────────────────`
      }
    },
    {
      type: "actions",
      block_id: "review_actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "OK → 公開へ" },
          style: "primary",
          action_id: "ok_move",
          value: JSON.stringify({ fileId: file.getId(), name: file.getName() }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "NG（理由入力）" },
          style: "danger",
          action_id: "ng_reason",
          value: JSON.stringify({ fileId: file.getId(), name: file.getName() }),
        },
      ],
    }
  ];

  const buttonResp = UrlFetchApp.fetch("https://slack.com/api/chat.postMessage", {
    method: "post",
    headers: { 
      Authorization: "Bearer " + CONFIG.slackBotToken
    },
    contentType: "application/json",
    payload: JSON.stringify({
      channel: CONFIG.slackChannelId,
      text: "審査ボタン",
      blocks: blocks,
    }),
    muteHttpExceptions: true,
  });

  const buttonData = JSON.parse(buttonResp.getContentText() || "{}");
  if (!buttonData.ok) {
    paperLog("[ERROR] [postPhotoToSlackWithBlockKit] ボタン投稿エラー", "error=" + buttonResp.getContentText());
    return;
  }

  const buttonTs = buttonData.ts;
  paperLog("[postPhotoToSlackWithBlockKit] ボタン投稿完了", "ts=" + buttonTs);
}

function doGet(event) {
  const fn = event?.parameter?.fn;
  if (fn) {
    // ===== サイネージAPI (list / img64 / image) =====
    try {
      if (fn === 'list') return handleList_();
      if (fn === 'img64') return handleImg64_(event);
      if (fn === 'image') return handleImage_(event);
      return ContentService.createTextOutput(JSON.stringify({ error: 'unknown fn' }))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({ error: String(err) }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // ===== 既存: 承認/非承認の移動アクション =====
  const action = event?.parameter?.action;
  const fileId = event?.parameter?.fileId;

  if (!action || !fileId) {
    return HtmlService.createHtmlOutput("パラメータが不足しています。");
  }

  try {
    if (action === "moveToOk") {
      moveFile(fileId, STATUS.approved, "");
      return HtmlService.createHtmlOutput("OK フォルダへ移動しました。");
    }

    if (action === "moveToNg") {
      moveFile(fileId, STATUS.rejected, "");
      return HtmlService.createHtmlOutput("NG フォルダへ移動しました。");
    }

    return HtmlService.createHtmlOutput("不明なアクションです。");
  } catch (err) {
    paperLog("[ERROR] doGetエラー:", err);
    return HtmlService.createHtmlOutput("処理中にエラーが発生しました。");
  }
}

function doOptions() {
  return buildCorsResponse();
}

function moveFile(fileId, status, reason, includeReasonInEmail) {
  // includeReasonInEmailが未指定の場合はtrue（後方互換性のため）
  if (includeReasonInEmail === undefined) {
    includeReasonInEmail = true;
  }
  
  paperLog("[moveFile] 開始", "fileId=" + fileId, "status=" + status, "includeReasonInEmail=" + includeReasonInEmail);
  
  try {
    const file = DriveApp.getFileById(fileId);
    paperLog("[moveFile] ファイル取得成功", "fileName=" + file.getName());
    
    // メールアドレスを取得
    let email = "";
    try {
      const description = file.getDescription();
      paperLog("[moveFile] ファイル説明取得", "hasDescription=" + !!description, "descriptionLength=" + (description?.length || 0));
      if (description) {
        // JSON形式で保存されている場合
        try {
          const metadata = JSON.parse(description);
          email = metadata.email || "";
          const maskedEmail = email ? (email.indexOf("@") > 0 ? email.substring(0, email.indexOf("@")) + "@***" : email.substring(0, 3) + "***") : "なし";
          paperLog("[moveFile] メールアドレス取得", "email=" + maskedEmail, "hasEmail=" + !!email);
        } catch (e) {
          // JSON形式でない場合はコメントのみなのでメールアドレスなし
          email = "";
          paperLog("[moveFile] 説明はJSON形式ではない（コメントのみ）", "email=" + email);
        }
      } else {
        paperLog("[moveFile] ファイル説明が空", "email=" + email);
      }
    } catch (e) {
      paperLog("[ERROR] [moveFile] メールアドレス取得エラー", "error=" + String(e), "email=" + email);
    }
    
    const currentParents = file.getParents();
    const targetFolderId = status === STATUS.approved ? CONFIG.okFolderId : CONFIG.ngFolderId;
    paperLog("[moveFile] ターゲットフォルダID", "targetFolderId=" + targetFolderId);
    
    const targetFolder = DriveApp.getFolderById(targetFolderId);
    paperLog("[moveFile] ターゲットフォルダ取得成功", "folderName=" + targetFolder.getName());

    // 現在の親フォルダからファイルを削除
    while (currentParents.hasNext()) {
      const parent = currentParents.next();
      paperLog("[moveFile] 親フォルダから削除", "parentId=" + parent.getId());
      parent.removeFile(file);
    }

    // ターゲットフォルダにファイルを追加
    targetFolder.addFile(file);
    paperLog("[moveFile] ファイル移動完了", "fileId=" + fileId, "status=" + status);
    
    // メールアドレスがある場合は常に審査結果をメール送信
    // NGの場合、includeReasonInEmailがfalseの場合は理由を含めない
    if (email) {
      const emailReason = (status === STATUS.rejected && !includeReasonInEmail) ? "" : (reason || "");
      const maskedEmailForLog = email.indexOf("@") > 0 ? email.substring(0, email.indexOf("@")) + "@***" : email.substring(0, 3) + "***";
      paperLog("[moveFile] メール送信を開始", "email=" + maskedEmailForLog, "status=" + status, "hasReason=" + !!emailReason, "includeReasonInEmail=" + includeReasonInEmail, "reasonLength=" + (emailReason?.length || 0));
      sendReviewResultEmail(email, file.getName(), status, emailReason, fileId);
    } else {
      paperLog("[moveFile] メールアドレスなしのためメール送信スキップ", "fileId=" + fileId);
    }
  } catch (err) {
    paperLog("[ERROR] [moveFile] エラー", "error=" + String(err), "stack=" + (err.stack || "なし"));
    throw err;
  }
}

function sendReviewResultEmail(email, fileName, status, reason, fileId) {
  // メールアドレスのマスキング用ヘルパー
  const maskEmail = (addr) => {
    if (!addr) return "なし";
    const atIndex = addr.indexOf("@");
    return atIndex > 0 ? addr.substring(0, atIndex) + "@***" : addr.substring(0, Math.min(3, addr.length)) + "***";
  };
  const maskedEmail = maskEmail(email);
  
  try {
    paperLog("[sendReviewResultEmail] 開始", "email=" + maskedEmail, "fileName=" + fileName, "status=" + status, "hasReason=" + !!reason, "reasonLength=" + (reason?.length || 0), "fileId=" + fileId);
    
    const subject = status === STATUS.approved 
      ? "【審査結果】画像が承認されました"
      : "【審査結果】画像が承認されませんでした";
    
    let body = "";
    if (status === STATUS.approved) {
      body = `お送りいただいた画像の審査が完了いたしました。

【審査結果】承認
【ファイル名】${fileName}

ご投稿いただいた画像は承認され、デジタルサイネージや公式サイトで公開される予定です。

ご協力ありがとうございました。`;
    } else {
      const reasonText = reason ? `\n【理由】${reason}` : "";
      body = `お送りいただいた画像の審査が完了いたしました。

【審査結果】非承認${reasonText}
【ファイル名】${fileName}

申し訳ございませんが、ご投稿いただいた画像は承認されませんでした。
ご理解のほどよろしくお願いいたします。`;
    }
    
    paperLog("[sendReviewResultEmail] メール送信準備完了", "to=" + maskedEmail, "subject=" + subject, "bodyLength=" + body.length, "hasReasonInBody=" + body.includes("【理由】"));
    
    // 自分のメールアドレスを取得（BCC用）
    let bccEmail = "";
    try {
      bccEmail = Session.getActiveUser().getEmail();
      paperLog("[sendReviewResultEmail] BCC用メールアドレス取得", "bccEmail=" + maskEmail(bccEmail));
    } catch (e) {
      paperLog("[WARN] [sendReviewResultEmail] BCC用メールアドレス取得失敗", "error=" + String(e));
    }
    
    const emailOptions = {
      to: email,
      subject: subject,
      body: body
    };
    
    // BCCが取得できた場合のみ追加
    if (bccEmail) {
      emailOptions.bcc = bccEmail;
    }
    
    MailApp.sendEmail(emailOptions);
    
    paperLog("[sendReviewResultEmail] メール送信成功", "email=" + maskedEmail, "subject=" + subject);
    
    // メール送信のログをlogAuditで記録
    if (fileId) {
      const emailStatus = status === STATUS.approved ? "EMAIL_OK" : "EMAIL_NG";
      const emailReason = reason || "";
      logAudit(emailStatus, fileId, fileName, "system", emailReason, "", "");
      paperLog("[sendReviewResultEmail] メール送信ログを記録", "fileId=" + fileId, "status=" + emailStatus);
    }
  } catch (err) {
    paperLog("[ERROR] [sendReviewResultEmail] メール送信エラー", "email=" + maskedEmail, "error=" + String(err), "errorName=" + (err.name || "なし"), "errorMessage=" + (err.message || "なし"), "stack=" + (err.stack || "なし"));
    // メール送信エラーは処理を続行する（ファイル移動は成功しているため）
  }
}

function buildJsonResponse(payload, status = 200) {
  const output = ContentService.createTextOutput(JSON.stringify({ ...payload, status }));
  output.setMimeType(ContentService.MimeType.JSON);
  applyCorsHeaders(output);
  return output;
}

function buildErrorResponse(message, status = 500) {
  return buildJsonResponse({ ok: false, error: message }, status);
}

function buildCorsResponse() {
  const output = ContentService.createTextOutput("");
  applyCorsHeaders(output);
  return output;
}

function applyCorsHeaders(output) {
  // Apps Script の TextOutput には setHeaders メソッドが存在しないため、
  // no-cors モードを使用しているため CORS ヘッダーは不要
  // エラーを防ぐために何もしない
  try {
    // 将来的にヘッダー設定が必要になった場合のためのプレースホルダー
    // output.setHeaders() は使用できない
  } catch (err) {
    paperLog("[WARN] applyCorsHeaders: ヘッダー設定はスキップされました", err);
  }
}

// =========================
// サイネージ API（list/img64/image）
// =========================

// 署名シークレット（CONFIGから取得）
function getSecret_() {
  return CONFIG.sharedSecret;
}

function signFor_(id, exp) {
  const data = `${id}.${exp}`;
  const bytes = Utilities.computeHmacSha256Signature(data, getSecret_());
  return Utilities.base64EncodeWebSafe(bytes);
}

function handleList_() {
  // signageFolderIdが未設定の場合はokFolderIdを使用
  const folderId = CONFIG.signageFolderId || CONFIG.okFolderId;
  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFiles();

  const items = [];
  while (files.hasNext()) {
    const f = files.next();
    const name = f.getName();
    const mime = f.getMimeType() || '';
    const isImage =
      mime.startsWith('image/') ||
      /heic|heif/i.test(mime) ||
      /\.(heic|heif|jpe?g|png|gif|webp|bmp|tiff?)$/i.test(name);
    if (!isImage) continue;

    const id = f.getId();
    const updated = f.getLastUpdated();
    const exp = Date.now() + CONFIG.signageExpiresMs;
    const sig = signFor_(id, exp);
    const base = ScriptApp.getService().getUrl();
    const url  = `${base}?fn=img64&id=${encodeURIComponent(id)}&exp=${exp}&sig=${encodeURIComponent(sig)}`;

    items.push({
      id, name, mimeType: mime,
      updatedAt: updated.toISOString(),
      size: f.getSize(),
      url,
    });
  }
  items.sort((a,b)=> new Date(b.updatedAt) - new Date(a.updatedAt));

  return ContentService
    .createTextOutput(JSON.stringify({ now: new Date().toISOString(), count: items.length, items }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleImg64_(e) {
  const id = e.parameter.id;
  const exp = Number(e.parameter.exp || 0);
  const sig = e.parameter.sig;
  if (!id || !exp || !sig) return ContentService.createTextOutput(JSON.stringify({error:'Bad Request'})).setMimeType(ContentService.MimeType.JSON);
  if (Date.now() > exp)   return ContentService.createTextOutput(JSON.stringify({error:'Link expired'})).setMimeType(ContentService.MimeType.JSON);
  if (sig !== signFor_(id, exp)) return ContentService.createTextOutput(JSON.stringify({error:'Invalid signature'})).setMimeType(ContentService.MimeType.JSON);

  const blob = DriveApp.getFileById(id).getBlob();
  const mime = blob.getContentType() || 'application/octet-stream';
  const b64  = Utilities.base64Encode(blob.getBytes());

  return ContentService
    .createTextOutput(JSON.stringify({ mime, data: b64 }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleImage_(e) {
  const id = e.parameter.id;
  const exp = Number(e.parameter.exp || 0);
  const sig = e.parameter.sig;
  if (!id || !exp || !sig) return ContentService.createTextOutput('Bad Request');

  if (Date.now() > exp) return ContentService.createTextOutput('Link expired');
  if (sig !== signFor_(id, exp)) return ContentService.createTextOutput('Invalid signature');

  const file = DriveApp.getFileById(id);
  const blob = file.getBlob();
  return ContentService.createOutput(blob);
}

// （必要に応じてCORSヘッダを付けるバリアント）
function jsonResponse_(obj, status, extraHeaders) {
  const text = JSON.stringify(obj, null, 2);
  const out = ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
  return addHeaders_(out, Object.assign({
    'Access-Control-Allow-Origin': CONFIG.signageAllowOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  }, extraHeaders || {}), status);
}

function textResponse_(text, status) {
  const out = ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.TEXT);
  return addHeaders_(out, {
    'Access-Control-Allow-Origin': CONFIG.signageAllowOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  }, status);
}

function addHeaders_(output, headers, status) {
  const resp = output;
  // Apps ScriptのContentServiceは任意ステータス設定APIがありません（＝常に200）。
  // ここでは可能な範囲でヘッダを付与します。
  if (headers) {
    const keys = Object.keys(headers);
    for (const k of keys) {
      resp.setHeader(k, String(headers[k]));
    }
  }
  return resp;
}
// =========================
// NG処理キュー
// =========================

/**
 * NG処理をキューに追加する
 * @param {Object} queueData - キューに追加するデータ
 */
function enqueueNGProcessing(queueData) {
  try {
    // キュー用スプレッドシートID（デバッグシートIDを使用）
    const sheetId = CONFIG.queueSheetId || CONFIG.debugSheetId;
    if (!sheetId) {
      paperLog("[WARN] [enqueueNGProcessing] キュー用シートIDが設定されていません。直接処理を実行します。");
      // フォールバック: 直接処理を実行
      processNGFromQueue(queueData);
      return;
    }
    
    const ss = SpreadsheetApp.openById(sheetId);
    let sh = ss.getSheetByName("NG処理キュー");
    if (!sh) {
      sh = ss.insertSheet("NG処理キュー");
      // ヘッダーを追加
      sh.appendRow([
        "タイムスタンプ",
        "ステータス",
        "ファイルID",
        "ファイル名",
        "理由",
        "メールに理由を含める",
        "ユーザーID",
        "チャンネルID",
        "メッセージTS",
        "ブロックJSON"
      ]);
    }
    
    // キューに追加
    sh.appendRow([
      queueData.timestamp,
      "PENDING",
      queueData.fileId,
      queueData.fileName,
      queueData.reason,
      queueData.includeReasonInEmail ? "YES" : "NO",
      queueData.userId,
      queueData.channel,
      queueData.ts,
      JSON.stringify(queueData.blocks)
    ]);
    
    paperLog("[enqueueNGProcessing] キューに追加完了", "fileId=" + queueData.fileId);
  } catch (err) {
    paperLog("[ERROR] [enqueueNGProcessing] キュー追加エラー", "error=" + String(err));
  }
  
  // ★ キュー追加後、非同期で処理を実行
  // Apps ScriptではreturnしてもバックグラウンドでLockServiceを使って処理を続行できる
  try {
    // スクリプトロックを取得してバックグラウンド処理を実行
    const lock = LockService.getScriptLock();
    if (lock.tryLock(0)) { // タイムアウト0で即座に試行
      try {
        // ロックを取得できたら処理を実行（他の処理と競合しない）
        processNGFromQueue(queueData);
      } finally {
        lock.releaseLock();
      }
    } else {
      // ロックを取得できなかった場合は、別のインスタンスが処理中
      paperLog("[enqueueNGProcessing] 別のインスタンスが処理中のためスキップ", "fileId=" + queueData.fileId);
    }
  } catch (processErr) {
    paperLog("[ERROR] [enqueueNGProcessing] 処理実行エラー", "error=" + String(processErr));
  }
}

/**
 * キューからNG処理を実行する
 * @param {Object} queueData - 処理データ
 */
function processNGFromQueue(queueData) {
  paperLog("[processNGFromQueue] NG処理開始", "fileId=" + queueData.fileId);
  
  try {
    // 1. まず「処理中...」メッセージを表示
    try {
      let updatedBlocks = JSON.parse(JSON.stringify(queueData.blocks || []));
      updatedBlocks = updatedBlocks.filter((b) => b.type !== "actions");
      updatedBlocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `🛑 非承認（<@${queueData.userId}>：${escapeMrkdwn(queueData.reason)}） → 処理中...` }]
      });
      
      UrlFetchApp.fetch("https://slack.com/api/chat.update", {
        method: "post",
        headers: { Authorization: "Bearer " + CONFIG.slackBotToken },
        contentType: "application/json",
        payload: JSON.stringify({
          channel: queueData.channel,
          ts: queueData.ts,
          text: "審査ボタン",
          blocks: updatedBlocks
        }),
        muteHttpExceptions: true,
      });
      
      paperLog("[processNGFromQueue] 「処理中...」メッセージ表示完了", "fileId=" + queueData.fileId);
    } catch (updateErr) {
      paperLog("[ERROR] [processNGFromQueue] 「処理中...」メッセージ表示エラー", "error=" + String(updateErr));
    }
    
    // 2. ファイルを NG フォルダへ移動
    moveFile(queueData.fileId, STATUS.rejected, queueData.reason, queueData.includeReasonInEmail);
    
    // 3. 監査ログを記録
    logAudit("NG", queueData.fileId, queueData.fileName, queueData.userId, queueData.reason, queueData.channel, queueData.ts);
    
    // 4. メッセージを最終状態に更新
    try {
      let updatedBlocks = JSON.parse(JSON.stringify(queueData.blocks || []));
      updatedBlocks = updatedBlocks.filter((b) => b.type !== "actions");
      updatedBlocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `🛑 非承認（<@${queueData.userId}>：${escapeMrkdwn(queueData.reason)}） → NGフォルダへ移動しました` }]
      });
      
      UrlFetchApp.fetch("https://slack.com/api/chat.update", {
        method: "post",
        headers: { Authorization: "Bearer " + CONFIG.slackBotToken },
        contentType: "application/json",
        payload: JSON.stringify({
          channel: queueData.channel,
          ts: queueData.ts,
          text: "審査ボタン",
          blocks: updatedBlocks
        }),
        muteHttpExceptions: true,
      });
      
      paperLog("[processNGFromQueue] メッセージ更新成功", "fileId=" + queueData.fileId);
    } catch (updateErr) {
      paperLog("[ERROR] [processNGFromQueue] メッセージ更新エラー", "error=" + String(updateErr));
    }
    
    paperLog("[processNGFromQueue] NG処理完了", "fileId=" + queueData.fileId);
  } catch (err) {
    paperLog("[ERROR] [processNGFromQueue] NG処理エラー", "error=" + String(err), "stack=" + (err.stack || "なし"));
    
    // エラーメッセージをスレッドに投稿
    try {
      UrlFetchApp.fetch("https://slack.com/api/chat.postMessage", {
        method: "post",
        headers: { Authorization: "Bearer " + CONFIG.slackBotToken },
        contentType: "application/json",
        payload: JSON.stringify({
          channel: queueData.channel,
          thread_ts: queueData.ts,
          text: `⚠️ NG処理エラー: ${escapeMrkdwn(String(err))}`
        }),
        muteHttpExceptions: true,
      });
    } catch (postErr) {
      paperLog("[ERROR] [processNGFromQueue] エラーメッセージ投稿失敗", "error=" + String(postErr));
    }
  }
}

// =========================
// 非同期NG処理（旧実装 - 互換性のため残す）
// =========================

/**
 * 非同期でNG処理を実行する
 * @param {Object} payload - 処理データ
 */
function handleAsyncNGProcessing(payload) {
  paperLog("[handleAsyncNGProcessing] 非同期NG処理開始", "fileId=" + payload.fileId);
  
  try {
    // 1. まず「処理中...」メッセージを表示
    try {
      let updatedBlocks = JSON.parse(JSON.stringify(payload.blocks || []));
      updatedBlocks = updatedBlocks.filter((b) => b.type !== "actions");
      updatedBlocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `🛑 非承認（<@${payload.userId}>：${escapeMrkdwn(payload.reason)}） → 処理中...` }]
      });
      
      UrlFetchApp.fetch("https://slack.com/api/chat.update", {
        method: "post",
        headers: { Authorization: "Bearer " + CONFIG.slackBotToken },
        contentType: "application/json",
        payload: JSON.stringify({
          channel: payload.channel,
          ts: payload.ts,
          text: "審査ボタン",
          blocks: updatedBlocks
        }),
        muteHttpExceptions: true,
      });
      
      paperLog("[handleAsyncNGProcessing] 「処理中...」メッセージ表示完了", "fileId=" + payload.fileId);
    } catch (updateErr) {
      paperLog("[ERROR] [handleAsyncNGProcessing] 「処理中...」メッセージ表示エラー", "error=" + String(updateErr));
    }
    
    // 2. ファイルを NG フォルダへ移動
    moveFile(payload.fileId, STATUS.rejected, payload.reason, payload.includeReasonInEmail);
    
    // 3. 監査ログを記録
    logAudit("NG", payload.fileId, payload.fileName, payload.userId, payload.reason, payload.channel, payload.ts);
    
    // 4. メッセージを最終状態に更新
    try {
      let updatedBlocks = JSON.parse(JSON.stringify(payload.blocks || []));
      updatedBlocks = updatedBlocks.filter((b) => b.type !== "actions");
      updatedBlocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `🛑 非承認（<@${payload.userId}>：${escapeMrkdwn(payload.reason)}） → NGフォルダへ移動しました` }]
      });
      
      UrlFetchApp.fetch("https://slack.com/api/chat.update", {
        method: "post",
        headers: { Authorization: "Bearer " + CONFIG.slackBotToken },
        contentType: "application/json",
        payload: JSON.stringify({
          channel: payload.channel,
          ts: payload.ts,
          text: "審査ボタン",
          blocks: updatedBlocks
        }),
        muteHttpExceptions: true,
      });
      
      paperLog("[handleAsyncNGProcessing] メッセージ更新成功", "fileId=" + payload.fileId);
    } catch (updateErr) {
      paperLog("[ERROR] [handleAsyncNGProcessing] メッセージ更新エラー", "error=" + String(updateErr));
    }
    
    paperLog("[handleAsyncNGProcessing] NG処理完了", "fileId=" + payload.fileId);
    return buildJsonResponse({ ok: true, message: "NG処理完了" });
  } catch (err) {
    paperLog("[ERROR] [handleAsyncNGProcessing] NG処理エラー", "error=" + String(err), "stack=" + (err.stack || "なし"));
    
    // エラーメッセージをスレッドに投稿
    try {
      UrlFetchApp.fetch("https://slack.com/api/chat.postMessage", {
        method: "post",
        headers: { Authorization: "Bearer " + CONFIG.slackBotToken },
        contentType: "application/json",
        payload: JSON.stringify({
          channel: payload.channel,
          thread_ts: payload.ts,
          text: `⚠️ NG処理エラー: ${escapeMrkdwn(String(err))}`
        }),
        muteHttpExceptions: true,
      });
    } catch (postErr) {
      paperLog("[ERROR] [handleAsyncNGProcessing] エラーメッセージ投稿失敗", "error=" + String(postErr));
    }
    
    return buildErrorResponse(String(err));
  }
}

// =========================
// Slack Interactivity 処理
// =========================

function handleSlackInteractivity(event) {
  paperLog("[handleSlackInteractivity] 関数が呼ばれました");
  
  try {
    // 署名検証（開発時はスキップ）
    // if (CONFIG.slackSigningSecret && !verifySlackSignature(event)) {
    //   return ContentService.createTextOutput("invalid signature").setMimeType(ContentService.MimeType.TEXT);
    // }

    const payloadRaw = event.parameter.payload || "";
    paperLog("[handleSlackInteractivity] payloadRaw確認", "hasPayload=" + !!payloadRaw, "length=" + (payloadRaw?.length || 0));
    
    if (!payloadRaw) {
      return ContentService.createTextOutput("ok").setMimeType(ContentService.MimeType.TEXT);
    }

    const payload = JSON.parse(payloadRaw);
    paperLog("[handleSlackInteractivity] payload解析完了", "type=" + (payload.type || "なし"));

    if (payload.type === "block_actions") {
      const action = payload.actions[0];
      const userId = payload.user.id;
      const channel = payload.channel.id;
      const ts = payload.message.ts;
      const val = JSON.parse(action.value);
      
      paperLog("[handleSlackInteractivity] block_actions", "action_id=" + action.action_id, "channel=" + channel, "ts=" + ts);

      if (action.action_id === "ok_move") {
        paperLog("[handleSlackInteractivity] OK処理開始", "fileId=" + val.fileId, "fileName=" + val.name);
        
        try {
          // ファイルを OK フォルダへ移動
          moveFile(val.fileId, STATUS.approved, "");

          // 監査ログを記録
          logAudit("OK", val.fileId, val.name, userId, "", channel, ts);

          // メッセージを更新してボタンを無効化し、完了ステータスを追加
          let updatedBlocks = JSON.parse(JSON.stringify(payload.message.blocks || []));
          paperLog("[handleSlackInteractivity] 元のブロック数", "count=" + updatedBlocks.length);
          
          // actionsブロックを削除
          updatedBlocks = updatedBlocks.filter((b) => b.type !== "actions");
          paperLog("[handleSlackInteractivity] actions削除後のブロック数", "count=" + updatedBlocks.length);
          
          // ステータスを追加
          updatedBlocks.push({
            type: "context",
            elements: [{ type: "mrkdwn", text: `✅ 承認済み by <@${userId}> → OKフォルダへ移動しました` }]
          });

          paperLog("[handleSlackInteractivity] chat.update呼び出し", "channel=" + channel, "ts=" + ts);
          const updateResp = UrlFetchApp.fetch("https://slack.com/api/chat.update", {
            method: "post",
            headers: { Authorization: "Bearer " + CONFIG.slackBotToken },
            contentType: "application/json",
            payload: JSON.stringify({
              channel: channel,
              ts: ts,
              text: "審査ボタン",
              blocks: updatedBlocks
            }),
            muteHttpExceptions: true,
          });
          
          const updateData = JSON.parse(updateResp.getContentText() || "{}");
          paperLog("[handleSlackInteractivity] chat.updateレスポンス", "ok=" + updateData.ok, "error=" + (updateData.error || "なし"));
          
          if (!updateData.ok) {
            paperLog("[ERROR] [handleSlackInteractivity] メッセージ更新エラー", "error=" + updateResp.getContentText());
          }
          
          paperLog("[handleSlackInteractivity] OK処理完了", "fileId=" + val.fileId);
        } catch (err) {
          paperLog("[ERROR] [handleSlackInteractivity] OK処理エラー", "error=" + String(err), "stack=" + (err.stack || "なし"));
          
          // エラーメッセージをスレッドに投稿
          UrlFetchApp.fetch("https://slack.com/api/chat.postMessage", {
            method: "post",
            headers: { Authorization: "Bearer " + CONFIG.slackBotToken },
            contentType: "application/json",
            payload: JSON.stringify({
              channel: channel,
              thread_ts: ts,
              text: `⚠️ OK処理エラー: ${escapeMrkdwn(String(err))}`
            }),
            muteHttpExceptions: true,
          });
        }
        return ContentService.createTextOutput("").setMimeType(ContentService.MimeType.TEXT);
      }

      if (action.action_id === "ng_reason") {
        // trigger_idの有効期限は3秒なので、最速でモーダルを開く
        try {
          const view = {
            type: "modal",
            callback_id: "ng_modal",
            title: { type: "plain_text", text: "NG理由" },
            submit: { type: "plain_text", text: "送信" },
            close: { type: "plain_text", text: "キャンセル" },
            private_metadata: JSON.stringify({
              fileId: val.fileId,
              name: val.name,
              channel: channel,
              ts: ts,
              blocks: payload.message.blocks
            }),
            blocks: [
              {
                type: "input",
                block_id: "reason_block",
                label: { type: "plain_text", text: "NG理由（選択）" },
                element: {
                  type: "static_select",
                  action_id: "reason_select",
                  placeholder: { type: "plain_text", text: "選択してください" },
                  options: [
                    { text: { type: "plain_text", text: "不適切な内容" }, value: "inappropriate" },
                    { text: { type: "plain_text", text: "肖像権・著作権の懸念" }, value: "rights" },
                    { text: { type: "plain_text", text: "画質/縦横比が基準外" }, value: "quality" },
                    { text: { type: "plain_text", text: "重複アップロード" }, value: "duplicate" },
                    { text: { type: "plain_text", text: "その他" }, value: "other" }
                  ]
                }
              },
              {
                type: "input",
                block_id: "reason_block2",
                optional: true,
                label: { type: "plain_text", text: "補足（任意）" },
                element: {
                  type: "plain_text_input",
                  action_id: "reason_text",
                  multiline: true,
                  placeholder: { type: "plain_text", text: "詳細やメモを入力" }
                }
              },
              {
                type: "section",
                block_id: "email_notify_block",
                text: {
                  type: "mrkdwn",
                  text: "NG理由をメールに含める場合はチェックしてください。"
                },
                accessory: {
                  type: "checkboxes",
                  action_id: "email_notify",
                  options: [
                    {
                      text: {
                        type: "plain_text",
                        text: "NG理由をメールに含める"
                      },
                      value: "include_reason"
                    }
                  ]
                }
              }
            ]
          };

          const modalResp = UrlFetchApp.fetch("https://slack.com/api/views.open", {
            method: "post",
            headers: { Authorization: "Bearer " + CONFIG.slackBotToken },
            contentType: "application/json",
            payload: JSON.stringify({
              trigger_id: payload.trigger_id,
              view: view
            }),
            muteHttpExceptions: true,
          });
          
          const modalData = JSON.parse(modalResp.getContentText() || "{}");
          if (!modalData.ok) {
            paperLog("[handleSlackInteractivity] モーダル起動失敗", "error=" + (modalData.error || "なし"));
            
            // エラーメッセージをスレッドに投稿
            UrlFetchApp.fetch("https://slack.com/api/chat.postMessage", {
              method: "post",
              headers: { Authorization: "Bearer " + CONFIG.slackBotToken },
              contentType: "application/json",
              payload: JSON.stringify({
                channel: channel,
                thread_ts: ts,
                text: `⚠️ モーダル起動エラー: ${modalData.error || "不明なエラー"}`
              }),
              muteHttpExceptions: true,
            });
          } else {
            paperLog("[handleSlackInteractivity] モーダル起動成功");
          }
        } catch (err) {
          paperLog("[handleSlackInteractivity] モーダルエラー", "error=" + String(err));
        }
        return ContentService.createTextOutput("").setMimeType(ContentService.MimeType.TEXT);
      }
    }

    if (payload.type === "view_submission" && payload.view?.callback_id === "ng_modal") {
      const meta = JSON.parse(payload.view.private_metadata || "{}");
      const st = payload.view.state.values;
      const reasonSel = st.reason_block?.reason_select?.selected_option?.text?.text || "";
      const reasonText = st.reason_block2?.reason_text?.value || "";
      const reason = [reasonSel, reasonText].filter(Boolean).join(" / ") || "（未記入）";
      const userId = payload.user?.id || "unknown";
      
      // メールに理由を含めるかのチェック状態を取得
      const includeReasonInEmail = st.email_notify_block?.email_notify?.selected_options?.length > 0;
      paperLog("[handleSlackInteractivity] NG処理開始", "fileId=" + meta.fileId, "reason=" + reason, "includeReasonInEmail=" + includeReasonInEmail);

      // ★ 最優先: モーダルを即座に閉じる（3秒タイムアウト対策）
      // 処理データをキューに保存し、すぐにレスポンスを返す
      
      try {
        const queueData = {
          fileId: meta.fileId,
          fileName: meta.name,
          reason: reason,
          includeReasonInEmail: includeReasonInEmail,
          userId: userId,
          channel: meta.channel,
          ts: meta.ts,
          blocks: meta.blocks,
          timestamp: new Date().toISOString()
        };
        
        // キューに保存（軽い処理）
        enqueueNGProcessing(queueData);
        
        paperLog("[handleSlackInteractivity] NG処理をキューに追加", "fileId=" + meta.fileId);
      } catch (queueErr) {
        paperLog("[ERROR] [handleSlackInteractivity] キュー追加エラー", "error=" + String(queueErr));
      }

      // ★ 最優先: モーダルを即座に閉じる（3秒タイムアウト対策）
      // 何もせずにすぐにレスポンスを返す
      paperLog("[handleSlackInteractivity] view_submission処理完了、モーダルを閉じます");
      return ContentService.createTextOutput("")
        .setMimeType(ContentService.MimeType.TEXT);
    }

    return ContentService.createTextOutput("ok").setMimeType(ContentService.MimeType.TEXT);
  } catch (err) {
    paperLog("[ERROR] Slack Interactivity エラー:", err);
    return ContentService.createTextOutput("error").setMimeType(ContentService.MimeType.TEXT);
  }
}

function verifySlackSignature(event) {
  try {
    const sig = event.headers["X-Slack-Signature"] || event.headers["x-slack-signature"];
    const ts = event.headers["X-Slack-Request-Timestamp"] || event.headers["x-slack-request-timestamp"];
    if (!sig || !ts) return false;

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(ts)) > 60 * 5) return false;

    const body = event.postData?.contents || "";
    const base = `v0:${ts}:${body}`;
    const mac = Utilities.computeHmacSha256Signature(base, CONFIG.slackSigningSecret);
    const hex = mac.map((b) => ("0" + (b & 0xff).toString(16)).slice(-2)).join("");
    const expected = `v0=${hex}`;
    return sig === expected;
  } catch (_) {
    return false;
  }
}

function replaceOriginalViaResponseUrl(responseUrl, baseBlocks, statusLine, removeActions) {
  paperLog("[replaceOriginalViaResponseUrl] 開始", "url=" + (responseUrl || "なし"), "statusLine=" + statusLine);
  
  let blocks = JSON.parse(JSON.stringify(baseBlocks || []));
  if (removeActions) {
    blocks = blocks.filter((b) => b.type !== "actions");
  }
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: statusLine }] });

  const resp = UrlFetchApp.fetch(responseUrl, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      replace_original: true,
      text: statusLine,
      blocks: blocks,
    }),
    muteHttpExceptions: true,
  });

  const code = resp.getResponseCode();
  const respText = resp.getContentText();
  paperLog("[replaceOriginalViaResponseUrl] レスポンス", "code=" + code, "body=" + respText.substring(0, 200));
  
  if (code < 200 || code >= 300) {
    throw new Error("response_url update failed: " + code + " " + respText);
  }
}

function escapeMrkdwn(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// =========================
// ログ機能
// =========================

/**
 * ログ出力関数
 * - 常にconsole.logで出力（Apps Scriptの実行ログで確認可能）
 * - デバッグモードが有効な場合のみスプレッドシートに書き込む（パフォーマンス考慮）
 * @param {...any} args - ログメッセージ（複数可）
 */
function paperLog() {
  // 引数を全部連結
  const msg = Array.from(arguments)
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
    .join(" ");

  // 常に console.log で出力（Apps Script の実行ログで確認可能）
  console.log("[LOG]", new Date().toISOString(), msg);

  // デバッグモードとスプレッドシートIDを直接取得（CONFIGが別ファイルで定義されている場合の対策）
  try {
    let debugMode = false;
    let sheetId = "";
    
    // CONFIGから直接取得（Code.gsの文頭で定義されているため常に利用可能）
    debugMode = CONFIG.debugMode;
    sheetId = CONFIG.debugSheetId || "";
    
    // デバッグモードが有効な場合のみスプレッドシートに出力（パフォーマンス考慮）
    if (!debugMode) {
      return;
    }

    // スプレッドシートにも出力（設定されている場合）
    if (!sheetId) {
      // DEBUG_SHEET_ID が未設定ならスプレッドシートへの書き込みはスキップ
      return;
    }
    const ss = SpreadsheetApp.openById(sheetId);
    const sh = ss.getSheets()[0];

    // 見出しが無ければ作成
    if (sh.getLastRow() === 0) {
      sh.appendRow(["timestamp", "message"]);
    }

    sh.appendRow([new Date(), msg]);
  } catch (err) {
    // スプレッドシートへの書き込みに失敗しても無視（console.log は既に出力済み）
    // エラーをログに記録（再帰呼び出しを避けるため、直接console.logを使用）
    console.warn("[WARN] paperLog spreadsheet write failed:", err);
  }
}

// =========================
// 監査ログ機能
// =========================

/**
 * OK/NG審査結果を監査ログとしてスプレッドシートに記録
 * @param {string} status - "OK" または "NG"
 * @param {string} fileId - ファイルID
 * @param {string} fileName - ファイル名
 * @param {string} userId - SlackユーザーID
 * @param {string} reason - NG理由（NGの場合のみ）
 * @param {string} channelId - SlackチャンネルID
 * @param {string} messageTs - SlackメッセージTS
 */
function logAudit(status, fileId, fileName, userId, reason, channelId, messageTs) {
  try {
    // 監査ログ用シートID（設定されていない場合はデバッグシートIDを使用）
    const sheetId = CONFIG.auditSheetId || CONFIG.debugSheetId;
    if (!sheetId) {
      paperLog("[WARN] [logAudit] シートIDが設定されていません。監査ログをスキップします。");
      return;
    }

    const ss = SpreadsheetApp.openById(sheetId);
    // 監査ログ用シートIDが設定されている場合は専用シートを使用、そうでない場合は最初のシートを使用
    let sh;
    if (CONFIG.auditSheetId) {
      // 監査ログ用シートを取得または作成
      sh = ss.getSheetByName("監査ログ") || ss.insertSheet("監査ログ");
    } else {
      // デバッグシートIDを使用する場合は、既存のシートに追加
      sh = ss.getSheets()[0];
    }

    // 見出しが無ければ作成
    if (sh.getLastRow() === 0) {
      sh.appendRow([
        "タイムスタンプ",
        "ステータス",
        "ファイルID",
        "ファイル名",
        "ユーザーID",
        "NG理由",
        "チャンネルID",
        "メッセージTS"
      ]);
    }

    // 監査ログを記録
    sh.appendRow([
      new Date(),
      status,
      fileId,
      fileName,
      userId,
      reason || "",
      channelId || "",
      messageTs || ""
    ]);

    paperLog("[logAudit] 監査ログを記録しました", "status=" + status, "fileId=" + fileId);
  } catch (err) {
    paperLog("[ERROR] [logAudit] 監査ログ記録エラー", "error=" + String(err), "stack=" + (err.stack || "なし"));
  }
}

