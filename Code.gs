const CONFIG = {
  inboxFolderId: "1ADisWsmPc81lqlV7-NWAK4WIeN9K_TGZ",
  okFolderId: "12CurPdxu1BlWC0k_9FTdOuYcTgCNO3_R",
  ngFolderId: "1sErg8MjdKFuxVzAmJ5BTkBIykohCl4E3",
  slackWebhookUrl: "https://hooks.slack.com/services/XXXX/XXXX/XXXX",
};

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
  try {
    if (!event?.postData?.contents) {
      return buildErrorResponse("リクエストデータが空です。", 400);
    }

    const payload = JSON.parse(event.postData.contents);
    validatePayload(payload);

    const folder = DriveApp.getFolderById(CONFIG.inboxFolderId);
    const filename = buildFileName(payload);
    const blob = createBlob(payload, filename);
    const file = folder.createFile(blob);
    file.setDescription(payload.comment || "");
    file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.VIEW);
    file.setProperty(META_KEYS.comment, payload.comment || "");
    file.setProperty(META_KEYS.uploadedAt, payload.timestamp || new Date().toISOString());
    file.setProperty(META_KEYS.status, STATUS.pending);

    notifySlack(file, payload);

    return buildJsonResponse({ ok: true, fileId: file.getId(), id: file.getId() });
  } catch (err) {
    console.error(err);
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
  if (!CONFIG.slackWebhookUrl || CONFIG.slackWebhookUrl.includes("hooks.slack.com/services/XXXX")) {
    return;
  }

  const okUrl = buildReviewUrl(file, STATUS.approved);
  const ngUrl = buildReviewUrl(file, STATUS.rejected);
  const fileUrl = `https://drive.google.com/open?id=${file.getId()}`;

  const message = {
    text: [
      ":sparkles: 新しい写真がアップロードされました。",
      `ファイル名: ${file.getName()}`,
      `コメント: ${payload.comment || "（なし）"}`,
      `<${fileUrl}|画像を開く>`,
      `<${okUrl}|OK フォルダへ移動> ｜ <${ngUrl}|NG フォルダへ移動>`,
    ].join("\n"),
  };

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(message),
    muteHttpExceptions: true,
  };

  UrlFetchApp.fetch(CONFIG.slackWebhookUrl, options);
}

function buildReviewUrl(file, status) {
  const action = status === STATUS.approved ? "moveToOk" : "moveToNg";
  const baseUrl = ScriptApp.getService().getUrl();
  const params = `?action=${action}&fileId=${encodeURIComponent(file.getId())}`;
  return `${baseUrl}${params}`;
}

function doGet(event) {
  const action = event?.parameter?.action;
  const fileId = event?.parameter?.fileId;

  if (!action || !fileId) {
    return HtmlService.createHtmlOutput("パラメータが不足しています。");
  }

  try {
    if (action === "moveToOk") {
      moveFile(fileId, STATUS.approved);
      return HtmlService.createHtmlOutput("OK フォルダへ移動しました。");
    }

    if (action === "moveToNg") {
      moveFile(fileId, STATUS.rejected);
      return HtmlService.createHtmlOutput("NG フォルダへ移動しました。");
    }

    return HtmlService.createHtmlOutput("不明なアクションです。");
  } catch (err) {
    console.error(err);
    return HtmlService.createHtmlOutput("処理中にエラーが発生しました。");
  }
}

function moveFile(fileId, status) {
  const file = DriveApp.getFileById(fileId);
  const currentParents = file.getParents();
  const targetFolderId = status === STATUS.approved ? CONFIG.okFolderId : CONFIG.ngFolderId;
  const targetFolder = DriveApp.getFolderById(targetFolderId);

  while (currentParents.hasNext()) {
    const parent = currentParents.next();
    parent.removeFile(file);
  }

  targetFolder.addFile(file);
  file.setProperty(META_KEYS.status, status);
}

function buildJsonResponse(payload, status = 200) {
  const output = ContentService.createTextOutput(JSON.stringify({ ...payload, status }));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

function buildErrorResponse(message, status = 500) {
  return buildJsonResponse({ ok: false, error: message }, status);
}

