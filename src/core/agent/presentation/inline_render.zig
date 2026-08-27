const std = @import("std");
const Allocator = std.mem.Allocator;
const ansi = @import("ansi.zig");
const tu = @import("text_util.zig");
const payload = @import("payload.zig");

pub fn writeInlineNoBold(
    alloc: Allocator,
    text: []const u8,
    out: *std.ArrayList(u8),
    restore_underline_after_link: bool,
    footnotes: ?*const payload.FootnoteSink,
    link_id: *u32,
) !void {
    var stripped: std.ArrayList(u8) = .empty;
    defer stripped.deinit(alloc);

    var i: usize = 0;
    var in_code: bool = false;
    while (i < text.len) {
        const c = text[i];
        if (c == '`') {
            in_code = !in_code;
            try stripped.append(alloc, c);
            i += 1;
            continue;
        }
        if (!in_code and c == '\\' and i + 1 < text.len and tu.isEscapedPunctuationAt(text, i + 1)) {
            try stripped.appendSlice(alloc, text[i .. i + 2]);
            i += 2;
            continue;
        }
        if (!in_code and c == '_' and tu.isValidUnderscoreOpen(text, i, 2)) {
            if (tu.findUnderscoreCloser(text, i + 2, 2)) |closer| {
                try stripped.appendSlice(alloc, text[i + 2 .. closer]);
                i = closer + 2;
                continue;
            }
        }
        if (!in_code and i + 1 < text.len and c == '*' and text[i + 1] == '*') {
            i += 2;
            continue;
        }
        try stripped.append(alloc, c);
        i += 1;
    }

    try writeInline(alloc, stripped.items, out, restore_underline_after_link, footnotes, link_id);
}

pub fn writeInline(
    alloc: Allocator,
    text: []const u8,
    out: *std.ArrayList(u8),
    restore_underline_after_link: bool,
    footnotes: ?*const payload.FootnoteSink,
    link_id: *u32,
) !void {
    var i: usize = 0;
    var in_bold: bool = false;
    var in_italic: bool = false;
    var in_underscore_bold: bool = false;
    var in_underscore_italic: bool = false;
    var in_strike: bool = false;
    var in_code: bool = false;
    var link_admission_suppressed_until: usize = 0;

    while (i < text.len) {
        const c = text[i];

        if (c == '`') {
            if (in_code) {
                try out.appendSlice(alloc, ansi.inline_code_close);
                in_code = false;
            } else {
                try out.appendSlice(alloc, ansi.inline_code_open);
                in_code = true;
            }
            i += 1;
            continue;
        }

        if (in_code) {
            try out.append(alloc, c);
            i += 1;
            continue;
        }

        if (c == '\\' and i + 1 < text.len and tu.isEscapedPunctuationAt(text, i + 1)) {
            if (text[i + 1] == '<') {
                link_admission_suppressed_until = @max(
                    link_admission_suppressed_until,
                    angleAutolinkCandidateEnd(text, i + 1),
                );
            }
            if (text[i + 1] == '!' and i + 2 < text.len and text[i + 2] == '[') {
                if (malformedInlineLinkCandidateEnd(text, i + 2)) |candidate_end| {
                    try out.appendSlice(alloc, text[i + 1 .. candidate_end]);
                    link_admission_suppressed_until = @max(link_admission_suppressed_until, candidate_end);
                    i = candidate_end;
                    continue;
                }
            }
            if (text[i + 1] == '[') {
                if (malformedInlineLinkCandidateEnd(text, i + 1)) |candidate_end| {
                    link_admission_suppressed_until = @max(link_admission_suppressed_until, candidate_end);
                }
            }
            try out.append(alloc, text[i + 1]);
            i += 2;
            continue;
        }

        if (i >= link_admission_suppressed_until and c == '!' and i + 1 < text.len and text[i + 1] == '[') {
            if (parseInlineImage(text, i)) |image| {
                try emitInlineLink(alloc, out, image, restore_underline_after_link, "▧ ", link_id);
                i = image.end;
                continue;
            }
            if (malformedInlineLinkCandidateEnd(text, i + 1)) |candidate_end| {
                link_admission_suppressed_until = @max(link_admission_suppressed_until, candidate_end);
            }
        }

        if (c == '[') {
            if (footnotes) |sink| {
                if (parseFootnoteReference(text, i)) |reference| {
                    const number = try sink.register(sink.ctx, alloc, reference.label);
                    try writeFootnoteMarker(alloc, out, number);
                    i = reference.end;
                    continue;
                }
            }
        }

        if (i >= link_admission_suppressed_until and c == '[') {
            if (parseInlineLink(text, i)) |link| {
                try emitInlineLink(alloc, out, link, restore_underline_after_link, null, link_id);
                i = link.end;
                continue;
            }
            if (malformedInlineLinkCandidateEnd(text, i)) |candidate_end| {
                link_admission_suppressed_until = @max(link_admission_suppressed_until, candidate_end);
            }
        }

        if (i >= link_admission_suppressed_until and c == '<') {
            if (parseAngleAutolink(text, i)) |link| {
                try emitInlineLink(alloc, out, link, restore_underline_after_link, null, link_id);
                i = link.end;
                continue;
            }
            link_admission_suppressed_until = @max(
                link_admission_suppressed_until,
                angleAutolinkCandidateEnd(text, i),
            );
        }

        if (i >= link_admission_suppressed_until) {
            if (parseBareUrl(text, i, in_bold, in_italic, in_underscore_bold, in_underscore_italic, in_strike)) |link| {
                try emitInlineLink(alloc, out, link, restore_underline_after_link, null, link_id);
                i = link.end;
                continue;
            }
        }

        if (c == '~' and i + 1 < text.len and text[i + 1] == '~') {
            if (in_strike) {
                if (i == 0 or tu.isSpace(text[i - 1])) {
                    try out.append(alloc, c);
                    i += 1;
                    continue;
                }
                try out.appendSlice(alloc, ansi.strike_close);
                in_strike = false;
            } else {
                if (i + 2 >= text.len or tu.isSpace(text[i + 2])) {
                    try out.append(alloc, c);
                    i += 1;
                    continue;
                }
                try out.appendSlice(alloc, ansi.strike_open);
                in_strike = true;
            }
            i += 2;
            continue;
        }

        if (c == '*' and i + 1 < text.len and text[i + 1] == '*') {
            if (in_bold) {
                if (i == 0 or tu.isSpace(text[i - 1])) {
                    try out.append(alloc, c);
                    i += 1;
                    continue;
                }
                try out.appendSlice(alloc, ansi.bold_close);
                in_bold = false;
                if (in_underscore_bold) try out.appendSlice(alloc, ansi.bold_open);
            } else {
                if (i + 2 >= text.len or tu.isSpace(text[i + 2])) {
                    try out.append(alloc, c);
                    i += 1;
                    continue;
                }
                try out.appendSlice(alloc, ansi.bold_open);
                in_bold = true;
            }
            i += 2;
            continue;
        }

        if (c == '_' and i + 1 < text.len and text[i + 1] == '_') {
            if (in_underscore_bold) {
                if (!tu.isValidUnderscoreClose(text, i, 2)) {
                    try out.append(alloc, c);
                    i += 1;
                    continue;
                }
                try out.appendSlice(alloc, ansi.bold_close);
                in_underscore_bold = false;
                if (in_bold) try out.appendSlice(alloc, ansi.bold_open);
            } else {
                if (!tu.isValidUnderscoreOpen(text, i, 2)) {
                    try out.append(alloc, c);
                    i += 1;
                    continue;
                }
                try out.appendSlice(alloc, ansi.bold_open);
                in_underscore_bold = true;
            }
            i += 2;
            continue;
        }

        if (c == '_') {
            if (in_underscore_italic) {
                if (!tu.isValidUnderscoreClose(text, i, 1)) {
                    try out.append(alloc, c);
                    i += 1;
                    continue;
                }
                try out.appendSlice(alloc, ansi.italic_close);
                in_underscore_italic = false;
                if (in_italic) try out.appendSlice(alloc, ansi.italic_open);
            } else {
                if (!tu.isValidUnderscoreOpen(text, i, 1)) {
                    try out.append(alloc, c);
                    i += 1;
                    continue;
                }
                try out.appendSlice(alloc, ansi.italic_open);
                in_underscore_italic = true;
            }
            i += 1;
            continue;
        }

        if (c == '*') {
            if (in_italic) {
                if (i == 0 or tu.isSpace(text[i - 1])) {
                    try out.append(alloc, c);
                    i += 1;
                    continue;
                }
                try out.appendSlice(alloc, ansi.italic_close);
                in_italic = false;
                if (in_underscore_italic) try out.appendSlice(alloc, ansi.italic_open);
            } else {
                if (i + 1 >= text.len or tu.isSpace(text[i + 1])) {
                    try out.append(alloc, c);
                    i += 1;
                    continue;
                }
                try out.appendSlice(alloc, ansi.italic_open);
                in_italic = true;
            }
            i += 1;
            continue;
        }

        try out.append(alloc, c);
        i += 1;
    }

    if (in_bold) try out.appendSlice(alloc, ansi.bold_close);
    if (in_italic) try out.appendSlice(alloc, ansi.italic_close);
    if (in_underscore_bold) try out.appendSlice(alloc, ansi.bold_close);
    if (in_underscore_italic) try out.appendSlice(alloc, ansi.italic_close);
    if (in_strike) try out.appendSlice(alloc, ansi.strike_close);
    if (in_code) try out.appendSlice(alloc, ansi.inline_code_close);
}

const ParsedFootnoteReference = struct {
    label: []const u8,
    end: usize,
};

fn parseFootnoteReference(text: []const u8, start: usize) ?ParsedFootnoteReference {
    if (start + 4 > text.len or text[start] != '[' or text[start + 1] != '^') return null;
    const close = std.mem.indexOfScalarPos(u8, text, start + 2, ']') orelse return null;
    if (close == start + 2) return null;
    if (close + 1 < text.len and text[close + 1] == ':') return null;
    return .{ .label = text[start + 2 .. close], .end = close + 1 };
}

fn writeFootnoteMarker(alloc: Allocator, out: *std.ArrayList(u8), number: usize) !void {
    var marker: [32]u8 = undefined;
    const bytes = try std.fmt.bufPrint(&marker, "[{d}]", .{number});
    try ansi.writeDim(alloc, out, bytes);
}

const InlineLink = struct {
    text: []const u8,
    url: []const u8,
    end: usize,
    destination_prefix: []const u8 = "",
    label_mode: enum { escaped, literal } = .escaped,
};

fn emitInlineLink(
    alloc: Allocator,
    out: *std.ArrayList(u8),
    link: InlineLink,
    restore_underline_after_link: bool,
    visible_prefix: ?[]const u8,
    link_id: *u32,
) !void {
    const id = link_id.*;
    link_id.* +%= 1;
    var id_buf: [32]u8 = undefined;
    const open = std.fmt.bufPrint(&id_buf, "\x1b]8;id=y2-{d};", .{id}) catch unreachable;
    try out.appendSlice(alloc, open);
    try out.appendSlice(alloc, link.destination_prefix);
    try out.appendSlice(alloc, link.url);
    try out.appendSlice(alloc, "\x1b\\");
    try out.appendSlice(alloc, ansi.underline_open);
    if (visible_prefix) |prefix| try out.appendSlice(alloc, prefix);
    const visible_text = if (link.text.len == 0 and visible_prefix != null) "image" else link.text;
    switch (link.label_mode) {
        .escaped => try tu.appendEscapedPunctuation(alloc, out, visible_text),
        .literal => try out.appendSlice(alloc, visible_text),
    }
    try out.appendSlice(alloc, ansi.underline_close);
    try out.appendSlice(alloc, "\x1b]8;;\x1b\\");
    if (restore_underline_after_link) try out.appendSlice(alloc, ansi.underline_open);
}

/// Rejects control bytes so a URL cannot terminate its OSC 8 wrapper.
fn parseInlineLink(text: []const u8, start: usize) ?InlineLink {
    return parseInlineBracketDestination(text, start, false);
}

fn parseInlineImage(text: []const u8, start: usize) ?InlineLink {
    if (start + 1 >= text.len or text[start] != '!' or text[start + 1] != '[') return null;
    return parseInlineBracketDestination(text, start + 1, true);
}

fn parseInlineBracketDestination(text: []const u8, start: usize, allow_empty_text: bool) ?InlineLink {
    if (start >= text.len or text[start] != '[') return null;
    var j = start + 1;
    while (j < text.len and text[j] != ']' and text[j] != '\n') : (j += 1) {}
    if (j >= text.len or text[j] != ']') return null;
    const text_end = j;
    if (!allow_empty_text and text_end == start + 1) return null;
    if (text_end + 1 >= text.len or text[text_end + 1] != '(') return null;
    var k = text_end + 2;
    while (k < text.len and text[k] != ')' and text[k] != '\n') : (k += 1) {}
    if (k >= text.len or text[k] != ')') return null;
    const url = text[text_end + 2 .. k];
    if (!isValidLinkUrl(url)) return null;
    return .{
        .text = text[start + 1 .. text_end],
        .url = url,
        .end = k + 1,
    };
}

fn parseAngleAutolink(text: []const u8, start: usize) ?InlineLink {
    if (start >= text.len or text[start] != '<') return null;

    const end = angleAutolinkCandidateEnd(text, start);
    if (end <= start + 1 or end > text.len or text[end - 1] != '>') return null;

    const value = text[start + 1 .. end - 1];
    if (isValidAngleAutolinkUri(value) and isValidLinkUrl(value)) {
        return .{
            .text = value,
            .url = value,
            .end = end,
            .label_mode = .literal,
        };
    }
    if (isValidAngleAutolinkEmail(value) and isValidLinkUrlWithPrefix("mailto:", value)) {
        return .{
            .text = value,
            .url = value,
            .end = end,
            .destination_prefix = "mailto:",
            .label_mode = .literal,
        };
    }
    return null;
}

fn angleAutolinkCandidateEnd(text: []const u8, start: usize) usize {
    if (start >= text.len or text[start] != '<') return start;

    var end = start + 1;
    while (end < text.len and text[end] != '>' and text[end] != '\n') : (end += 1) {}
    return if (end < text.len and text[end] == '>') end + 1 else end;
}

fn isValidAngleAutolinkUri(value: []const u8) bool {
    var colon: usize = 0;
    while (colon < value.len and value[colon] != ':') : (colon += 1) {}
    if (colon < 2 or colon > 32 or colon == value.len or !tu.isAsciiAlpha(value[0])) return false;

    for (value[1..colon]) |byte| {
        if (!tu.isAsciiAlphaNumeric(byte) and byte != '+' and byte != '-' and byte != '.') return false;
    }
    for (value[colon + 1 ..]) |byte| {
        if (byte <= ' ' or byte == '<' or byte == '>') return false;
    }
    return true;
}

fn isValidAngleAutolinkEmail(value: []const u8) bool {
    var at_index: ?usize = null;
    for (value, 0..) |byte, index| {
        if (byte == '@') {
            if (at_index != null) return false;
            at_index = index;
        }
    }

    const at = at_index orelse return false;
    if (at == 0 or at + 1 >= value.len) return false;
    for (value[0..at]) |byte| if (!isAngleAutolinkEmailLocalByte(byte)) return false;

    var label_start = at + 1;
    var index = label_start;
    while (index <= value.len) : (index += 1) {
        if (index != value.len and value[index] != '.') continue;
        if (!isValidAngleAutolinkEmailDomainLabel(value[label_start..index])) return false;
        label_start = index + 1;
    }
    return true;
}

fn isAngleAutolinkEmailLocalByte(byte: u8) bool {
    return tu.isAsciiAlphaNumeric(byte) or switch (byte) {
        '.', '!', '#', '$', '%', '&', '\'', '*', '+', '/', '=', '?', '^', '_', '`', '{', '|', '}', '~', '-' => true,
        else => false,
    };
}

fn isValidAngleAutolinkEmailDomainLabel(label: []const u8) bool {
    if (label.len == 0 or label.len > 63) return false;
    for (label, 0..) |byte, index| {
        if (index == 0 or index + 1 == label.len) {
            if (!tu.isAsciiAlphaNumeric(byte)) return false;
        } else if (!tu.isAsciiAlphaNumeric(byte) and byte != '-') {
            return false;
        }
    }
    return true;
}

fn parseBareUrl(
    text: []const u8,
    start: usize,
    in_bold: bool,
    in_italic: bool,
    in_underscore_bold: bool,
    in_underscore_italic: bool,
    in_strike: bool,
) ?InlineLink {
    if (!isBareUrlBoundary(text, start, in_underscore_bold, in_underscore_italic)) return null;
    const scheme_len: usize = if (std.mem.startsWith(u8, text[start..], "https://"))
        "https://".len
    else if (std.mem.startsWith(u8, text[start..], "http://"))
        "http://".len
    else
        return null;

    var end = start + scheme_len;
    while (end < text.len and !isBareUrlTerminator(text, end, in_bold, in_italic, in_underscore_bold, in_underscore_italic, in_strike)) : (end += 1) {}
    while (end > start + scheme_len and tu.isTrailingUrlPunctuation(text[end - 1])) : (end -= 1) {}

    const url = text[start..end];
    if (!isValidLinkUrl(url)) return null;
    return .{
        .text = url,
        .url = url,
        .end = end,
    };
}

fn malformedInlineLinkCandidateEnd(text: []const u8, start: usize) ?usize {
    if (start >= text.len or text[start] != '[') return null;

    var label_end = start + 1;
    while (label_end < text.len and text[label_end] != ']' and text[label_end] != '\n') : (label_end += 1) {}
    if (label_end >= text.len or text[label_end] != ']') return null;
    if (label_end + 1 >= text.len or text[label_end + 1] != '(') return null;

    var candidate_end = label_end + 2;
    while (candidate_end < text.len and text[candidate_end] != ')' and text[candidate_end] != '\n') : (candidate_end += 1) {}
    if (candidate_end < text.len and text[candidate_end] == ')') return candidate_end + 1;
    return candidate_end;
}

fn isValidLinkUrl(url: []const u8) bool {
    if (url.len == 0 or url.len > ansi.max_link_url_bytes) return false;
    for (url) |b| if (b < 0x20 or b == 0x7f) return false;
    return true;
}

fn isValidLinkUrlWithPrefix(prefix: []const u8, url: []const u8) bool {
    if (prefix.len + url.len > ansi.max_link_url_bytes) return false;
    for (prefix) |byte| if (byte < 0x20 or byte == 0x7f) return false;
    return isValidLinkUrl(url);
}

fn isBareUrlBoundary(text: []const u8, start: usize, in_underscore_bold: bool, in_underscore_italic: bool) bool {
    if (start == 0) return true;
    const previous = text[start - 1];
    if (!tu.isAsciiWordByte(previous) and previous != '<') return true;
    if (in_underscore_italic and start >= 1 and tu.isValidUnderscoreOpen(text, start - 1, 1)) return true;
    return in_underscore_bold and start >= 2 and tu.isValidUnderscoreOpen(text, start - 2, 2);
}

fn isBareUrlTerminator(
    text: []const u8,
    index: usize,
    in_bold: bool,
    in_italic: bool,
    in_underscore_bold: bool,
    in_underscore_italic: bool,
    in_strike: bool,
) bool {
    const c = text[index];
    if (tu.isAsciiWhitespace(c) or c == ')' or c == ']' or c == '}' or c == '>') return true;
    if (in_strike and c == '~' and index + 1 < text.len and text[index + 1] == '~') return true;
    if (in_underscore_bold and tu.isValidUnderscoreClose(text, index, 2)) return true;
    if (in_underscore_italic and tu.isValidUnderscoreClose(text, index, 1)) return true;
    if (c != '*') return false;
    if (in_bold and index + 1 < text.len and text[index + 1] == '*') return true;
    return in_italic;
}
