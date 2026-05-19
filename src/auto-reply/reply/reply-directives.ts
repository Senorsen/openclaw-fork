import { splitMediaFromOutput } from "../../media/parse.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
import { isSilentReplyPayloadText, stripSilentToken, SILENT_REPLY_TOKEN } from "../tokens.js";

export type ReplyDirectiveParseResult = {
  text: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  replyToId?: string;
  replyToCurrent?: boolean;
  replyToTag: boolean;
  audioAsVoice?: boolean;
  isSilent: boolean;
};

export type ReplyDirectiveParseOptions = {
  currentMessageId?: string;
  silentToken?: string;
  extractMarkdownImages?: boolean;
};

export function parseReplyDirectives(
  raw: string,
  options: ReplyDirectiveParseOptions = {},
): ReplyDirectiveParseResult {
  const split = splitMediaFromOutput(raw, {
    extractMarkdownImages: options.extractMarkdownImages,
  });
  let text = split.text ?? "";

  const replyParsed = parseInlineDirectives(text, {
    currentMessageId: options.currentMessageId,
    stripAudioTag: false,
    stripReplyTags: true,
  });

  if (replyParsed.hasReplyTag) {
    text = replyParsed.text;
  }

  const silentToken = options.silentToken ?? SILENT_REPLY_TOKEN;
  const isSilent = isSilentReplyPayloadText(text, silentToken);
  if (isSilent) {
    // Entire message is just the silent token — suppress it completely.
    text = "";
  } else if (text.includes(silentToken)) {
    // Mixed content with trailing NO_REPLY — strip the token and deliver the rest.
    text = stripSilentToken(text, silentToken);
  }

  return {
    text,
    mediaUrls: split.mediaUrls,
    mediaUrl: split.mediaUrl,
    replyToId: replyParsed.replyToId,
    replyToCurrent: replyParsed.replyToCurrent || undefined,
    replyToTag: replyParsed.hasReplyTag,
    audioAsVoice: split.audioAsVoice,
    isSilent,
  };
}
