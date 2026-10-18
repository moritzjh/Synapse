// Debug tool: prints token ids for each line on stdin.
//   ./build/tokenize models/x/tokenizer.json < input.txt
#include <iostream>
#include <string>

#include "tokenizer.hpp"

int main(int argc, char** argv) {
  if (argc < 2) {
    std::cerr << "usage: tokenize <tokenizer.json> [max_len]\n";
    return 1;
  }
  Tokenizer tok(argv[1]);
  size_t max_len = argc > 2 ? std::stoul(argv[2]) : 100000;
  std::string line;
  while (std::getline(std::cin, line)) {
    auto ids = tok.encode(line, max_len);
    for (size_t i = 0; i < ids.size(); ++i) std::cout << (i ? " " : "") << ids[i];
    std::cout << "\n";
  }
}
