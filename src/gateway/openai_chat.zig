const std = @import("std");
const build_options = @import("build_options");
const image_attachments = @import("../core/images/image_attachments.zig");
const io_mod = @import("../core/shared/io.zig");
const model_tool_schema = @import("../core/tooling/model_tool_schema.zig");
const secret = @import("../core/auth/secret.zig");
const stream_provider = @import("../core/agent/stream_provider.zig");
const types = @import("../core/shared/types.zig");
const http_runtime = @import("http_runtime.zig");

const Allocator = std.mem.Allocator;

pub const default_y2_chat_url = "https://api.y2.dev/api/v1/chat/completions";
pub const default_model = "y2-agent";
pub const chat_url_env = "Y2_API_CHAT_URL";
pub const openai_base_url_env = "OPENAI_BASE_URL";

const max_error_body_bytes: usize = 1024 * 1024;
const max_sse_line_bytes: usize = 32 * 1024 * 1024;
const max_sse_aggregate_bytes: usize = 64 * 1024 * 1024;
const max_sse_events: usize = 100_000;
const max_tool_calls: usize = 128;
const max_tool_identity_bytes: usize = 1024;
const max_tool_arguments_bytes: usize = 4 * 1024 * 1024;
const transfer_buffer_bytes: usize = 256 * 1024;
const connect_timeout_ms: i64 = 30_000;
const user_agent = "y2-intel-harness/" ++ build_options.app_version;

pub const Mode = enum {
    y2_agent,
    openai_compatible,
};

pub const agent_stream_provider = stream_provider.Provider{
    .stream_fn = streamCompletion,
};

pub fn modeForEndpoint(endpoint: []const u8) Mode {
    return if (std.mem.eql(u8, std.mem.trimEnd(u8, endpoint, "/"), default_y2_chat_url))
        .y2_agent
    else
        .openai_compatible;
}

pub fn configuredMode() Mode {
    if (io_mod.getenv(chat_url_env)) |endpoint| return modeForEndpoint(endpoint);
    if (io_mod.getenv(openai_base_url_env) != null) return .openai_compatible;
    return .y2_agent;
}

pub fn endpointAlloc(alloc: Allocator) ![]u8 {
    const endpoint = if (io_mod.getenv(chat_url_env)) |configured|
        try alloc.dupe(u8, configured)
    else if (io_mod.getenv(openai_base_url_env)) |base|
        try appendChatCompletionsPath(alloc, base)
    else
        try alloc.dupe(u8, default_y2_chat_url);
    errdefer alloc.free(endpoint);
    try validateEndpoint(endpoint);
    return endpoint;
}

fn appendChatCompletionsPath(alloc: Allocator, base: []const u8) ![]u8 {
    const uri = std.Uri.parse(base) catch return error.InvalidApiEndpoint;
    if (uri.query != null or uri.fragment != null) return error.InvalidApiEndpoint;
    const trimmed = std.mem.trimEnd(u8, base, "/");
    if (std.mem.endsWith(u8, trimmed, "/chat/completions")) return alloc.dupe(u8, trimmed);
    return std.fmt.allocPrint(alloc, "{s}/chat/completions", .{trimmed});
}

fn validateEndpoint(endpoint: []const u8) !void {
    const uri = std.Uri.parse(endpoint) catch return error.InvalidApiEndpoint;
    if (uri.host == null or uri.user != null or uri.password != null or uri.fragment != null) {
        return error.InvalidApiEndpoint;
    }
    if (std.ascii.eqlIgnoreCase(uri.scheme, "https")) return;
    if (http_runtime.isLoopbackHttpUrl(endpoint)) return;
    return error.InvalidApiEndpoint;
}

pub fn buildRequest(
    alloc: Allocator,
    request: stream_provider.RequestData,
    mode: Mode,
) ![]u8 {
    if (request.budget) |budget| {
        if (budget.cancel_flag) |flag| if (flag.load(.seq_cst)) return error.Cancelled;
        _ = budget.deadline;
    }
    try validateModel(request.model, mode);

    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    const writer = &out.writer;
    try writer.writeAll("{\"model\":");
    try std.json.Stringify.value(request.model, .{}, writer);
    try writer.writeAll(",\"stream\":true,\"messages\":[");
    try writeMessages(writer, alloc, request.messages, request.verified_images, mode);
    try writer.writeByte(']');

    if (mode == .openai_compatible) {
        const tool_count = try writeTools(writer, alloc, request);
        if (tool_count > 0) {
            try writer.writeAll(",\"tool_choice\":");
            const tool_choice: types.ToolChoice = if (request.vision_mode == .required) .required else request.tool_choice;
            try std.json.Stringify.value(tool_choice.label(), .{}, writer);
            try writer.writeAll(",\"parallel_tool_calls\":true");
        } else if (request.tool_choice == .none) {
            try writer.writeAll(",\"tool_choice\":\"none\"");
        }
        if (request.max_output_tokens) |limit| {
            try writer.print(",\"max_tokens\":{d}", .{limit});
        }
        if (request.provider_options.reasoning) |effort| {
            try writer.writeAll(",\"reasoning_effort\":");
            try std.json.Stringify.value(effort.label(), .{}, writer);
        }
        if (request.response_format) |format| {
            if (format.schema != .object) return error.InvalidStructuredResponseSchema;
            try writer.writeAll(",\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":");
            try std.json.Stringify.value(format.name, .{}, writer);
            try writer.writeAll(",\"description\":");
            try std.json.Stringify.value(format.description, .{}, writer);
            try writer.writeAll(",\"schema\":");
            try std.json.Stringify.value(format.schema, .{}, writer);
            try writer.writeAll(",\"strict\":true}}");
        }
    }

    try writer.writeByte('}');
    return out.toOwnedSlice();
}

fn validateModel(model: []const u8, mode: Mode) !void {
    if (model.len == 0 or model.len > 1024) return error.InvalidApiModel;
    for (model) |byte| if (byte <= 0x20 or byte == 0x7f) return error.InvalidApiModel;
    if (mode == .y2_agent and
        !std.mem.eql(u8, model, "y2-agent") and
        !std.mem.eql(u8, model, "agent-y2"))
    {
        return error.InvalidY2AgentModel;
    }
}

fn writeMessages(
    writer: *std.Io.Writer,
    alloc: Allocator,
    messages: []const types.ChatMessage,
    images: ?[]const image_attachments.VerifiedSnapshot,
    mode: Mode,
) !void {
    var first = true;
    for (messages, 0..) |message, index| {
        if (mode == .y2_agent and message.role != .user and message.role != .assistant) continue;
        if (mode == .y2_agent and (message.content == null or message.content.?.len == 0)) continue;
        if (!first) try writer.writeByte(',');
        first = false;

        try writer.writeAll("{\"role\":");
        try std.json.Stringify.value(roleName(message.role), .{}, writer);

        const attach_images = mode == .openai_compatible and
            images != null and
            index == messages.len - 1 and
            message.role == .user;
        if (attach_images) {
            try writer.writeAll(",\"content\":[{\"type\":\"text\",\"text\":");
            try std.json.Stringify.value(message.content orelse "", .{}, writer);
            try writer.writeByte('}');
            for (images.?) |image| {
                try writer.writeAll(",{");
                try writeImagePart(writer, alloc, image);
                try writer.writeByte('}');
            }
            try writer.writeByte(']');
        } else if (message.role == .assistant and message.content == null) {
            try writer.writeAll(",\"content\":null");
        } else {
            try writer.writeAll(",\"content\":");
            try std.json.Stringify.value(message.content orelse "", .{}, writer);
        }

        if (mode == .openai_compatible) switch (message.role) {
            .assistant => if (message.tool_calls.len > 0) try writeAssistantToolCalls(writer, message.tool_calls),
            .tool => {
                try writer.writeAll(",\"tool_call_id\":");
                try std.json.Stringify.value(message.tool_call_id orelse "", .{}, writer);
                if (message.tool_name) |name| {
                    try writer.writeAll(",\"name\":");
                    try std.json.Stringify.value(name, .{}, writer);
                }
            },
            else => {},
        };
        try writer.writeByte('}');
    }
}

fn roleName(role: types.ChatRole) []const u8 {
    return switch (role) {
        .system => "system",
        .user => "user",
        .assistant => "assistant",
        .tool => "tool",
    };
}

fn writeImagePart(
    writer: *std.Io.Writer,
    alloc: Allocator,
    image: image_attachments.VerifiedSnapshot,
) !void {
    const encoded_len = std.base64.standard.Encoder.calcSize(image.bytes.len);
    const encoded = try alloc.alloc(u8, encoded_len);
    defer alloc.free(encoded);
    _ = std.base64.standard.Encoder.encode(encoded, image.bytes);
    try writer.writeAll("\"type\":\"image_url\",\"image_url\":{\"url\":\"data:");
    try writer.writeAll(image.media_type);
    try writer.writeAll(";base64,");
    try writer.writeAll(encoded);
    try writer.writeAll("\"}");
}

fn writeAssistantToolCalls(writer: *std.Io.Writer, calls: []const types.ToolCall) !void {
    try writer.writeAll(",\"tool_calls\":[");
    for (calls, 0..) |call, index| {
        if (index > 0) try writer.writeByte(',');
        try writer.writeAll("{\"id\":");
        try std.json.Stringify.value(call.id, .{}, writer);
        try writer.writeAll(",\"type\":\"function\",\"function\":{\"name\":");
        try std.json.Stringify.value(call.name, .{}, writer);
        try writer.writeAll(",\"arguments\":");
        try std.json.Stringify.value(
            if (call.argument_integrity == .valid) call.arguments_json else "{}",
            .{},
            writer,
        );
        try writer.writeAll("}}");
    }
    try writer.writeByte(']');
}

fn writeTools(
    writer: *std.Io.Writer,
    alloc: Allocator,
    request: stream_provider.RequestData,
) !usize {
    const tools = request.tools;
    var serialized: std.Io.Writer.Allocating = .init(alloc);
    defer serialized.deinit();
    try serialized.writer.writeAll(",\"tools\":[");
    var count: usize = 0;

    if (request.vision_mode == .required) {
        const vision = tools.registry.lookup("vision") orelse return error.VisionToolNotRegistered;
        try writeFunctionTool(alloc, &serialized.writer, vision.model_schema.name, vision.model_schema.description, vision.model_schema.input_schema);
        try serialized.writer.writeByte(']');
        try writer.writeAll(serialized.written());
        return 1;
    }

    for (tools.advertised_names) |name| {
        if (tools.advertisedFunction(name)) |function| {
            if (count > 0) try serialized.writer.writeByte(',');
            try writeFunctionTool(alloc, &serialized.writer, function.name, function.description, function.input_schema);
        } else {
            const tool = tools.registry.lookup(name) orelse return error.AdvertisedToolNotRegistered;
            // Provider-executed tools use gateway-specific schemas and cannot be
            // represented by the standard Chat Completions function-tool shape.
            // Keep direct endpoints usable by omitting those advertisements.
            if (tool.provider_executed) continue;
            if (count > 0) try serialized.writer.writeByte(',');
            try writeFunctionTool(alloc, &serialized.writer, tool.model_schema.name, tool.model_schema.description, tool.model_schema.input_schema);
        }
        count += 1;
    }
    for (tools.additional_functions) |tool| {
        if (containsName(tools.advertised_names, tool.name)) continue;
        if (count > 0) try serialized.writer.writeByte(',');
        try writeFunctionTool(alloc, &serialized.writer, tool.name, tool.description, tool.input_schema);
        count += 1;
    }
    for (tools.selected_dynamic) |tool| {
        if (containsName(tools.advertised_names, tool.name)) continue;
        if (count > 0) try serialized.writer.writeByte(',');
        try writeDynamicFunctionTool(&serialized.writer, tool);
        count += 1;
    }
    if (request.vision_mode == .optional and !containsName(tools.advertised_names, "vision")) {
        const vision = tools.registry.lookup("vision") orelse return error.VisionToolNotRegistered;
        if (count > 0) try serialized.writer.writeByte(',');
        try writeFunctionTool(alloc, &serialized.writer, vision.model_schema.name, vision.model_schema.description, vision.model_schema.input_schema);
        count += 1;
    }
    try serialized.writer.writeByte(']');
    if (count > 0) try writer.writeAll(serialized.written());
    return count;
}

fn containsName(names: []const []const u8, expected: []const u8) bool {
    for (names) |name| if (std.mem.eql(u8, name, expected)) return true;
    return false;
}

fn writeFunctionTool(
    alloc: Allocator,
    writer: *std.Io.Writer,
    name: []const u8,
    description: []const u8,
    schema: model_tool_schema.ObjectSchema,
) !void {
    try writer.writeAll("{\"type\":\"function\",\"function\":{\"name\":");
    try std.json.Stringify.value(name, .{}, writer);
    try writer.writeAll(",\"description\":");
    try std.json.Stringify.value(description, .{}, writer);
    try writer.writeAll(",\"parameters\":");
    try model_tool_schema.writeObjectSchema(alloc, writer, schema);
    try writer.writeAll("}}");
}

fn writeDynamicFunctionTool(
    writer: *std.Io.Writer,
    tool: stream_provider.DynamicFunctionTool,
) !void {
    try writer.writeAll("{\"type\":\"function\",\"function\":{\"name\":");
    try std.json.Stringify.value(tool.name, .{}, writer);
    try writer.writeAll(",\"description\":");
    try std.json.Stringify.value(tool.description, .{}, writer);
    try writer.writeAll(",\"parameters\":");
    try std.json.Stringify.value(tool.input_schema, .{}, writer);
    try writer.writeAll("}}");
}

const ToolAccumulator = struct {
    index: usize,
    id: std.ArrayList(u8) = .empty,
    name: std.ArrayList(u8) = .empty,
    arguments: std.ArrayList(u8) = .empty,
    started: bool = false,

    fn deinit(self: *ToolAccumulator, alloc: Allocator) void {
        self.id.deinit(alloc);
        self.name.deinit(alloc);
        self.arguments.deinit(alloc);
        self.* = undefined;
    }
};

const StreamCallbacks = struct {
    context: *anyopaque,
    on_content: stream_provider.StreamCallback,
    on_tool_start: ?stream_provider.ToolStartCallback = null,
    on_reasoning: ?stream_provider.StreamCallback = null,
    on_tool_input: ?stream_provider.StreamCallback = null,
};

const Reducer = struct {
    content: std.ArrayList(u8) = .empty,
    tools: std.ArrayList(ToolAccumulator) = .empty,
    generation_id: ?[]u8 = null,
    finish_reason: ?types.ProviderFinishReason = null,
    usage: types.Usage = .{},
    aggregate_bytes: usize = 0,
    event_count: usize = 0,

    fn deinit(self: *Reducer, alloc: Allocator) void {
        self.content.deinit(alloc);
        for (self.tools.items) |*tool| tool.deinit(alloc);
        self.tools.deinit(alloc);
        if (self.generation_id) |id| alloc.free(id);
        self.* = undefined;
    }

    fn applyJson(
        self: *Reducer,
        alloc: Allocator,
        json_text: []const u8,
        callbacks: StreamCallbacks,
        cancel_flag: *std.atomic.Value(bool),
        content_capture_limit: ?usize,
    ) !void {
        if (cancel_flag.load(.seq_cst)) return error.Cancelled;
        self.event_count = try checkedAdd(self.event_count, 1, max_sse_events);
        self.aggregate_bytes = try checkedAdd(self.aggregate_bytes, json_text.len, max_sse_aggregate_bytes);

        var parsed = std.json.parseFromSlice(std.json.Value, alloc, json_text, .{}) catch
            return error.InvalidOpenAIChatEvent;
        defer parsed.deinit();
        if (parsed.value != .object) return error.InvalidOpenAIChatEvent;
        const root = parsed.value.object;

        if (self.generation_id == null) if (stringField(root, "id")) |id| {
            if (id.len > max_tool_identity_bytes) return error.OpenAIChatResourceLimitExceeded;
            self.generation_id = try alloc.dupe(u8, id);
        };
        if (root.get("usage")) |usage| if (usage == .object) {
            self.usage.input_tokens = unsignedField(usage.object, "prompt_tokens") orelse self.usage.input_tokens;
            self.usage.output_tokens = unsignedField(usage.object, "completion_tokens") orelse self.usage.output_tokens;
        };

        const choices = root.get("choices") orelse return;
        if (choices != .array or choices.array.items.len == 0) return;
        const choice = choices.array.items[0];
        if (choice != .object) return error.InvalidOpenAIChatEvent;
        if (stringField(choice.object, "finish_reason")) |finish_reason| {
            self.finish_reason = parseFinishReason(finish_reason);
        }
        const delta = choice.object.get("delta") orelse return;
        if (delta != .object) return error.InvalidOpenAIChatEvent;

        if (stringField(delta.object, "content")) |content| {
            callbacks.on_content(callbacks.context, content);
            try appendCaptured(&self.content, alloc, content, content_capture_limit);
        }
        if (stringField(delta.object, "reasoning_content")) |reasoning| {
            if (callbacks.on_reasoning) |callback| callback(callbacks.context, reasoning);
        }
        const tool_deltas = delta.object.get("tool_calls") orelse return;
        if (tool_deltas != .array) return error.InvalidOpenAIChatEvent;
        for (tool_deltas.array.items, 0..) |tool_delta, position| {
            if (tool_delta != .object) return error.InvalidOpenAIChatEvent;
            const index = unsignedField(tool_delta.object, "index") orelse position;
            if (index >= max_tool_calls) return error.OpenAIChatResourceLimitExceeded;
            const tool = try self.toolForIndex(alloc, @intCast(index));
            if (stringField(tool_delta.object, "id")) |id| {
                try appendBounded(&tool.id, alloc, id, max_tool_identity_bytes);
            }
            if (tool_delta.object.get("function")) |function| if (function == .object) {
                if (stringField(function.object, "name")) |name| {
                    try appendBounded(&tool.name, alloc, name, max_tool_identity_bytes);
                }
                if (stringField(function.object, "arguments")) |arguments| {
                    try appendBounded(&tool.arguments, alloc, arguments, max_tool_arguments_bytes);
                    if (callbacks.on_tool_input) |callback| callback(callbacks.context, arguments);
                }
            };
            if (!tool.started and tool.id.items.len > 0 and tool.name.items.len > 0) {
                tool.started = true;
                if (callbacks.on_tool_start) |callback| {
                    callback(callbacks.context, tool.id.items, tool.name.items, null);
                }
            }
        }
    }

    fn toolForIndex(self: *Reducer, alloc: Allocator, index: usize) !*ToolAccumulator {
        for (self.tools.items) |*tool| if (tool.index == index) return tool;
        if (self.tools.items.len >= max_tool_calls) return error.OpenAIChatToolCallLimitExceeded;
        try self.tools.append(alloc, .{ .index = index });
        return &self.tools.items[self.tools.items.len - 1];
    }

    fn finish(self: *Reducer, alloc: Allocator, saw_done: bool) !types.ModelCompletion {
        _ = saw_done;
        if (self.finish_reason == null) return error.OpenAIChatStreamIncomplete;
        const content = if (self.content.items.len > 0) try self.content.toOwnedSlice(alloc) else null;
        errdefer if (content) |value| alloc.free(value);

        const calls: []types.ToolCall = if (self.tools.items.len > 0)
            try alloc.alloc(types.ToolCall, self.tools.items.len)
        else
            &.{};
        var initialized: usize = 0;
        errdefer {
            for (calls[0..initialized]) |call| types.freeToolCall(alloc, call);
            if (calls.len > 0) alloc.free(calls);
        }
        for (self.tools.items, 0..) |*tool, index| {
            if (tool.id.items.len == 0 or tool.name.items.len == 0) return error.InvalidOpenAIChatToolCall;
            const id = try tool.id.toOwnedSlice(alloc);
            errdefer alloc.free(id);
            const name = try tool.name.toOwnedSlice(alloc);
            errdefer alloc.free(name);
            const arguments = if (tool.arguments.items.len > 0)
                try tool.arguments.toOwnedSlice(alloc)
            else
                try alloc.dupe(u8, "{}");
            errdefer alloc.free(arguments);
            calls[index] = .{
                .id = id,
                .name = name,
                .arguments_json = arguments,
                .argument_integrity = try types.ToolArgumentIntegrity.classifySerialized(alloc, arguments),
            };
            initialized += 1;
        }

        const generation_id = self.generation_id;
        self.generation_id = null;
        return .{
            .content = content,
            .tool_calls = calls,
            .generation_id = generation_id,
            .finish_reason = self.finish_reason,
            .usage = self.usage,
        };
    }
};

fn checkedAdd(current: usize, amount: usize, limit: usize) !usize {
    const total = std.math.add(usize, current, amount) catch
        return error.OpenAIChatResourceLimitExceeded;
    if (total > limit) return error.OpenAIChatResourceLimitExceeded;
    return total;
}

fn appendBounded(list: *std.ArrayList(u8), alloc: Allocator, bytes: []const u8, limit: usize) !void {
    _ = try checkedAdd(list.items.len, bytes.len, limit);
    try list.appendSlice(alloc, bytes);
}

fn appendCaptured(list: *std.ArrayList(u8), alloc: Allocator, bytes: []const u8, limit: ?usize) !void {
    const remaining = if (limit) |cap| cap -| list.items.len else bytes.len;
    try list.appendSlice(alloc, bytes[0..@min(bytes.len, remaining)]);
}

fn stringField(object: std.json.ObjectMap, name: []const u8) ?[]const u8 {
    const value = object.get(name) orelse return null;
    return if (value == .string) value.string else null;
}

fn unsignedField(object: std.json.ObjectMap, name: []const u8) ?u64 {
    const value = object.get(name) orelse return null;
    return if (value == .integer and value.integer >= 0) @intCast(value.integer) else null;
}

fn parseFinishReason(value: []const u8) types.ProviderFinishReason {
    if (std.mem.eql(u8, value, "stop")) return .stop;
    if (std.mem.eql(u8, value, "length")) return .length;
    if (std.mem.eql(u8, value, "content_filter")) return .content_filter;
    if (std.mem.eql(u8, value, "tool_calls") or std.mem.eql(u8, value, "function_call")) return .tool_calls;
    return .other;
}

const SseReader = struct {
    pending_line: std.ArrayList(u8) = .empty,
    saw_done: bool = false,

    fn deinit(self: *SseReader, alloc: Allocator) void {
        self.pending_line.deinit(alloc);
    }

    fn release(self: *SseReader) void {
        self.pending_line.clearRetainingCapacity();
    }

    fn next(self: *SseReader, alloc: Allocator, reader: anytype) !?[]const u8 {
        while (true) {
            const line = try self.readLine(alloc, reader) orelse return null;
            const trimmed = std.mem.trim(u8, line, " \t\r");
            if (trimmed.len == 0 or trimmed[0] == ':') {
                self.release();
                continue;
            }
            if (!std.mem.startsWith(u8, trimmed, "data:")) {
                self.release();
                continue;
            }
            const data = std.mem.trim(u8, trimmed["data:".len..], " \t");
            if (std.mem.eql(u8, data, "[DONE]")) {
                self.saw_done = true;
                return null;
            }
            return data;
        }
    }

    fn readLine(self: *SseReader, alloc: Allocator, reader: anytype) !?[]const u8 {
        while (true) {
            const fragment = reader.takeDelimiter('\n') catch |err| switch (err) {
                error.StreamTooLong => {
                    const buffered = reader.buffered();
                    if (buffered.len == 0) return error.OpenAIChatSseReadStalled;
                    if (buffered.len > max_sse_line_bytes - self.pending_line.items.len) {
                        return error.OpenAIChatSseEventTooLarge;
                    }
                    try self.pending_line.appendSlice(alloc, buffered);
                    reader.tossBuffered();
                    continue;
                },
                error.ReadFailed => return error.ReadFailed,
            } orelse {
                if (self.pending_line.items.len > 0) return self.pending_line.items;
                return null;
            };
            if (fragment.len > max_sse_line_bytes - self.pending_line.items.len) {
                return error.OpenAIChatSseEventTooLarge;
            }
            if (self.pending_line.items.len == 0) return fragment;
            try self.pending_line.appendSlice(alloc, fragment);
            return self.pending_line.items;
        }
    }
};

pub fn consumeSse(
    alloc: Allocator,
    reader: anytype,
    callback_ctx: *anyopaque,
    on_content_chunk: stream_provider.StreamCallback,
    on_tool_start: ?stream_provider.ToolStartCallback,
    on_reasoning_chunk: ?stream_provider.StreamCallback,
    on_tool_input_chunk: ?stream_provider.StreamCallback,
    cancel_flag: *std.atomic.Value(bool),
    content_capture_limit: ?usize,
) !types.ModelCompletion {
    var reducer: Reducer = .{};
    defer reducer.deinit(alloc);
    var sse: SseReader = .{};
    defer sse.deinit(alloc);
    const callbacks = StreamCallbacks{
        .context = callback_ctx,
        .on_content = on_content_chunk,
        .on_tool_start = on_tool_start,
        .on_reasoning = on_reasoning_chunk,
        .on_tool_input = on_tool_input_chunk,
    };
    while (try sse.next(alloc, reader)) |json_text| {
        defer sse.release();
        try reducer.applyJson(alloc, json_text, callbacks, cancel_flag, content_capture_limit);
        if (reducer.finish_reason != null) break;
    }
    return reducer.finish(alloc, sse.saw_done);
}

fn streamCompletion(
    _: ?*anyopaque,
    alloc: Allocator,
    request: stream_provider.ModelRequest,
) !stream_provider.Result {
    if (request.cancel_flag.load(.seq_cst)) return error.Cancelled;
    if (request.credential.source == .chatgpt_subscription or request.credential.source == .grok_subscription) {
        return error.ApiKeyCredentialRequired;
    }
    const endpoint = try endpointAlloc(alloc);
    defer alloc.free(endpoint);
    const payload = try buildRequest(alloc, request.data(), modeForEndpoint(endpoint));
    defer alloc.free(payload);
    return streamPrepared(alloc, request, endpoint, payload) catch |err| {
        if (request.cancel_flag.load(.seq_cst)) return error.Cancelled;
        request.attempt_evidence.network_failure = http_runtime.networkFailureEvidence(err, request.delivery.load());
        return err;
    };
}

const OpenedRequest = struct {
    request: ?std.http.Client.Request,

    pub fn deinit(self: *OpenedRequest, _: Allocator) void {
        if (self.request) |*request| request.deinit();
        self.request = null;
    }

    pub fn take(self: *OpenedRequest) std.http.Client.Request {
        const request = self.request.?;
        self.request = null;
        return request;
    }
};

const OpenRequestOperation = struct {
    client: *std.http.Client,
    uri: std.Uri,
    auth_header: []const u8,

    pub fn run(self: *@This()) !OpenedRequest {
        return .{ .request = try self.client.request(.POST, self.uri, .{
            .headers = .{
                .content_type = .{ .override = "application/json" },
                .authorization = .{ .override = self.auth_header },
                .accept_encoding = .omit,
                .user_agent = .{ .override = user_agent },
            },
            .extra_headers = &.{.{ .name = "accept", .value = "text/event-stream" }},
            .keep_alive = false,
            .redirect_behavior = .unhandled,
        }) };
    }
};

pub fn streamPrepared(
    alloc: Allocator,
    request: stream_provider.ModelRequest,
    endpoint: []const u8,
    payload: []const u8,
) !stream_provider.Result {
    const auth_header = try std.fmt.allocPrint(alloc, "Bearer {s}", .{request.credential.secret});
    defer secret.zeroAndFree(alloc, auth_header);
    const uri = try std.Uri.parse(endpoint);

    var client: std.http.Client = .{ .allocator = alloc, .io = io_mod.getIo() };
    defer client.deinit();
    var operation = OpenRequestOperation{
        .client = &client,
        .uri = uri,
        .auth_header = auth_header,
    };
    const connect_deadline = std.Io.Clock.Timestamp.fromNow(io_mod.getIo(), .{
        .clock = .awake,
        .raw = .fromMilliseconds(connect_timeout_ms),
    });
    try request.admission.admit();
    var opened = try http_runtime.runBoundedHttpOperation(
        OpenedRequest,
        alloc,
        request.cancel_flag,
        connect_deadline,
        &operation,
    );
    var http_request = opened.take();
    defer http_request.deinit();
    var cancel_watch_done = std.atomic.Value(bool).init(false);
    const cancel_watcher = if (http_request.connection) |connection|
        try http_runtime.spawnHttpCancelWatcher(
            &cancel_watch_done,
            request.cancel_flag,
            connection.stream_writer.stream,
        )
    else
        null;
    defer {
        cancel_watch_done.store(true, .seq_cst);
        if (cancel_watcher) |thread| thread.join();
    }
    if (request.cancel_flag.load(.seq_cst)) return error.Cancelled;

    http_request.transfer_encoding = .{ .content_length = payload.len };
    var send_buffer: [8192]u8 = undefined;
    request.delivery.markPossiblySent();
    var body_writer = try http_request.sendBodyUnflushed(&send_buffer);
    try body_writer.writer.writeAll(payload);
    try body_writer.end();
    if (http_request.connection) |connection| try connection.flush();
    if (request.cancel_flag.load(.seq_cst)) return error.Cancelled;

    var response = try http_request.receiveHead(&.{});
    if (response.head.status != .ok) {
        const retry_after_seconds = retryAfterSeconds(response.head);
        var transfer: [16 * 1024]u8 = undefined;
        const reader = response.reader(&transfer);
        const body = reader.allocRemaining(alloc, .limited(max_error_body_bytes)) catch |err| switch (err) {
            error.StreamTooLong => try alloc.dupe(u8, "API error response exceeded the local limit"),
            else => return err,
        };
        return .{ .failed = .{
            .kind = failureKind(response.head.status),
            .detail = body,
            .retry_after_seconds = retry_after_seconds,
            .ownership = .owned,
        } };
    }

    var transfer_buffer: [transfer_buffer_bytes]u8 = undefined;
    const reader = response.reader(&transfer_buffer);
    var events = request.events;
    const completion = try consumeSse(
        alloc,
        reader,
        &events,
        EventBridge.content,
        EventBridge.toolStart,
        EventBridge.reasoning,
        EventBridge.toolInput,
        request.cancel_flag,
        request.content_capture_limit,
    );
    return .{ .completed = .{
        .completion = completion,
        .usage = .{ .immediate = null },
        .ownership = .owned,
    } };
}

fn retryAfterSeconds(head: std.http.Client.Response.Head) ?u64 {
    var headers = head.iterateHeaders();
    while (headers.next()) |header| {
        if (!std.ascii.eqlIgnoreCase(header.name, "retry-after")) continue;
        return std.fmt.parseInt(u64, header.value, 10) catch null;
    }
    return null;
}

const EventBridge = struct {
    fn sink(raw: *anyopaque) *stream_provider.EventSink {
        return @ptrCast(@alignCast(raw));
    }

    fn content(raw: *anyopaque, chunk: []const u8) void {
        sink(raw).emit(.{ .content_delta = chunk });
    }

    fn reasoning(raw: *anyopaque, chunk: []const u8) void {
        sink(raw).emit(.{ .reasoning_delta = chunk });
    }

    fn toolInput(raw: *anyopaque, chunk: []const u8) void {
        sink(raw).emit(.{ .tool_input_delta = chunk });
    }

    fn toolStart(raw: *anyopaque, id: []const u8, name: []const u8, label: ?[]const u8) void {
        sink(raw).emit(.{ .tool_started = .{ .id = id, .name = name, .label = label } });
    }
};

fn failureKind(status: std.http.Status) stream_provider.FailureKind {
    return switch (status) {
        .bad_request => .invalid_request,
        .unauthorized => .unauthorized,
        .forbidden => .forbidden,
        .payload_too_large => .request_too_large,
        .too_many_requests => .rate_limited,
        .internal_server_error => .server_error,
        .bad_gateway => .bad_gateway,
        .service_unavailable => .unavailable,
        .gateway_timeout => .gateway_timeout,
        else => .provider_error,
    };
}

test "OpenAI-compatible failures preserve numeric Retry-After pacing" {
    const head = try std.http.Client.Response.Head.parse(
        "HTTP/1.1 503 Service Unavailable\r\n" ++
            "Retry-After: 7\r\n" ++
            "Content-Length: 0\r\n\r\n",
    );
    try std.testing.expectEqual(@as(?u64, 7), retryAfterSeconds(head));
}

test "Y2 request contains only the documented Agent Y2 compatibility fields" {
    const messages = [_]types.ChatMessage{
        .{ .role = .system, .content = "Local system prompt" },
        .{ .role = .user, .content = "What changed?" },
        .{ .role = .assistant, .content = "Earlier answer" },
        .{ .role = .tool, .tool_call_id = "call_1", .content = "tool output" },
    };
    const body = try buildRequest(std.testing.allocator, .{
        .model = "y2-agent",
        .messages = &messages,
        .tool_choice = .auto,
        .provider_options = .{ .reasoning = types.ReasoningEffort.literal("high") },
        .max_output_tokens = 42,
    }, .y2_agent);
    defer std.testing.allocator.free(body);
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, body, .{});
    defer parsed.deinit();

    try std.testing.expect(std.mem.find(u8, body, "\"model\":\"y2-agent\"") != null);
    try std.testing.expect(std.mem.find(u8, body, "\"stream\":true") != null);
    try std.testing.expect(std.mem.find(u8, body, "What changed?") != null);
    try std.testing.expect(std.mem.find(u8, body, "Earlier answer") != null);
    try std.testing.expect(std.mem.find(u8, body, "Local system prompt") == null);
    try std.testing.expect(std.mem.find(u8, body, "tool output") == null);
    try std.testing.expect(std.mem.find(u8, body, "max_tokens") == null);
    try std.testing.expect(std.mem.find(u8, body, "tools") == null);
}

test "OpenAI-compatible request preserves local function tool history" {
    const tool = model_tool_schema.FunctionSchema{
        .name = "read_file",
        .description = "Read a file",
        .input_schema = .{},
    };
    const messages = [_]types.ChatMessage{
        .{ .role = .system, .content = "Be concise." },
        .{ .role = .user, .content = "Read it." },
        .{ .role = .assistant, .tool_calls = &.{.{ .id = "call_1", .name = "read_file", .arguments_json = "{\"path\":\"README.md\"}" }} },
        .{ .role = .tool, .tool_call_id = "call_1", .tool_name = "read_file", .content = "contents" },
    };
    const body = try buildRequest(std.testing.allocator, .{
        .model = "gpt-compatible",
        .messages = &messages,
        .tools = .{ .additional_functions = &.{tool} },
        .tool_choice = .auto,
        .provider_options = .{ .reasoning = types.ReasoningEffort.literal("high") },
        .max_output_tokens = 2048,
    }, .openai_compatible);
    defer std.testing.allocator.free(body);
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, body, .{});
    defer parsed.deinit();

    try std.testing.expect(std.mem.find(u8, body, "\"tools\":[{\"type\":\"function\"") != null);
    try std.testing.expect(std.mem.find(u8, body, "\"tool_call_id\":\"call_1\"") != null);
    try std.testing.expect(std.mem.find(u8, body, "\"max_tokens\":2048") != null);
    try std.testing.expect(std.mem.find(u8, body, "\"reasoning_effort\":\"high\"") != null);
}

test "OpenAI-compatible request replaces malformed historical tool arguments" {
    const calls = [_]types.ToolCall{.{
        .id = "call_bad",
        .name = "read_file",
        .arguments_json = "{\"depth\":1,\"depth\":2}",
        .argument_integrity = .malformed_json,
    }};
    const messages = [_]types.ChatMessage{.{
        .role = .assistant,
        .tool_calls = &calls,
    }};
    const body = try buildRequest(std.testing.allocator, .{
        .model = "gpt-compatible",
        .messages = &messages,
        .tool_choice = .auto,
        .provider_options = .{},
    }, .openai_compatible);
    defer std.testing.allocator.free(body);

    try std.testing.expect(std.mem.find(u8, body, "\"arguments\":\"{}\"") != null);
    try std.testing.expect(std.mem.find(u8, body, "\"depth\":1") == null);
}

test "OpenAI-compatible SSE reduces Y2 text and standard tool deltas" {
    const sse_text =
        "data: {\"id\":\"chat_1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n" ++
        "data: {\"id\":\"chat_1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello\"},\"finish_reason\":null}]}\n\n" ++
        "data: {\"id\":\"chat_1\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"README.md\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":4}}\n\n" ++
        "data: [DONE]\n\n";
    var reader: std.Io.Reader = .fixed(sse_text);
    var cancelled = std.atomic.Value(bool).init(false);
    const Capture = struct {
        content: std.ArrayList(u8) = .empty,
        saw_tool: bool = false,

        fn contentChunk(raw: *anyopaque, chunk: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(raw));
            self.content.appendSlice(std.testing.allocator, chunk) catch unreachable;
        }

        fn toolStart(raw: *anyopaque, id: []const u8, name: []const u8, _: ?[]const u8) void {
            const self: *@This() = @ptrCast(@alignCast(raw));
            self.saw_tool = std.mem.eql(u8, id, "call_1") and std.mem.eql(u8, name, "read_file");
        }
    };
    var capture: Capture = .{};
    defer capture.content.deinit(std.testing.allocator);
    var completion = try consumeSse(
        std.testing.allocator,
        &reader,
        &capture,
        Capture.contentChunk,
        Capture.toolStart,
        null,
        null,
        &cancelled,
        null,
    );
    defer freeCompletion(std.testing.allocator, &completion);

    try std.testing.expectEqualStrings("hello", capture.content.items);
    try std.testing.expect(capture.saw_tool);
    try std.testing.expectEqual(types.ProviderFinishReason.tool_calls, completion.finish_reason.?);
    try std.testing.expectEqual(@as(?u64, 10), completion.usage.input_tokens);
    try std.testing.expectEqual(@as(usize, 1), completion.tool_calls.len);
    try std.testing.expectEqualStrings("{\"path\":\"README.md\"}", completion.tool_calls[0].arguments_json);
}

test "OpenAI-compatible SSE rejects an out-of-range tool index" {
    const sse_text =
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":128,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n" ++
        "data: [DONE]\n\n";
    var reader: std.Io.Reader = .fixed(sse_text);
    var cancelled = std.atomic.Value(bool).init(false);
    const Capture = struct {
        fn contentChunk(_: *anyopaque, _: []const u8) void {}
    };
    var capture: u8 = 0;

    try std.testing.expectError(error.OpenAIChatResourceLimitExceeded, consumeSse(
        std.testing.allocator,
        &reader,
        &capture,
        Capture.contentChunk,
        null,
        null,
        null,
        &cancelled,
        null,
    ));
}

test "OpenAI-compatible SSE rejects DONE without a completion event" {
    const sse_text =
        "data: {\"type\":\"text-delta\",\"delta\":\"legacy\"}\n\n" ++
        "data: [DONE]\n\n";
    var reader: std.Io.Reader = .fixed(sse_text);
    var cancelled = std.atomic.Value(bool).init(false);
    const Capture = struct {
        fn contentChunk(_: *anyopaque, _: []const u8) void {}
    };
    var capture: u8 = 0;

    try std.testing.expectError(error.OpenAIChatStreamIncomplete, consumeSse(
        std.testing.allocator,
        &reader,
        &capture,
        Capture.contentChunk,
        null,
        null,
        null,
        &cancelled,
        null,
    ));
}

fn freeCompletion(alloc: Allocator, completion: *types.ModelCompletion) void {
    if (completion.content) |content| alloc.free(@constCast(content));
    if (completion.generation_id) |id| alloc.free(@constCast(id));
    types.freeToolCallSlice(alloc, @constCast(completion.tool_calls));
    completion.* = .{};
}
