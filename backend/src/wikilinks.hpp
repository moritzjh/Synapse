#pragma once

#include <string>
#include <string_view>
#include <vector>

// Extracts link targets from Obsidian-style [[Target]] / [[Target|Alias]] /
// [[Target#Heading]] syntax. Returns unique targets in order of appearance.
std::vector<std::string> extract_wikilinks(std::string_view text);
