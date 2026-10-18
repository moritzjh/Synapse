#pragma once

#include <functional>
#include <json.hpp>
#include <optional>
#include <string>
#include <vector>

#include "service.hpp"

// Model Context Protocol server (JSON-RPC 2.0). Exposes the whole app –
// notes (as Markdown), search, graph, flashcards, reviews and exams – as
// tools, so assistants like Claude can read and write your knowledge base.
//
// Transports: Streamable HTTP at POST /mcp (main.cpp), and stdio via
// `synapse mcp`, which forwards to a running backend.
class McpServer {
 public:
  explicit McpServer(Service& service);

  // Handles one JSON-RPC message (or batch); returns nothing for notifications.
  std::optional<nlohmann::json> handle(const nlohmann::json& message);

 private:
  struct ToolResult {
    std::string text;
    nlohmann::json structured;
  };
  struct Tool {
    std::string name, title, description;
    nlohmann::json schema;
    std::function<ToolResult(const nlohmann::json&)> run;
    bool read_only = true;
  };

  std::optional<nlohmann::json> handle_one(const nlohmann::json& msg);
  nlohmann::json call_tool(const nlohmann::json& params);
  void register_tools();
  int64_t resolve_note(const nlohmann::json& args);

  Service& service_;
  std::vector<Tool> tools_;
};

// stdio transport: reads JSON-RPC lines from stdin, forwards them to
// <url>/mcp and writes the responses to stdout.
int run_mcp_stdio_bridge(const std::string& url);
