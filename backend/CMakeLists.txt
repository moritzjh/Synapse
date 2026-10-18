cmake_minimum_required(VERSION 3.20)
project(synapse_backend C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -march=native")

find_package(SQLite3 REQUIRED)
find_package(Threads REQUIRED)

set(ORT_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/onnxruntime)
find_library(ONNXRUNTIME_LIB onnxruntime PATHS ${ORT_DIR}/lib NO_DEFAULT_PATH)
if(NOT ONNXRUNTIME_LIB)
  message(FATAL_ERROR "ONNX Runtime not found – run ./scripts/setup_onnxruntime.sh first")
endif()

add_library(synapse_core STATIC
  src/db.cpp
  src/note_store.cpp
  src/wikilinks.cpp
  src/content.cpp
  src/fsrs.cpp
  src/tokenizer.cpp
  src/embedder.cpp
  src/semantic_index.cpp
  src/markdown.cpp
  src/vault.cpp
  src/service.cpp
  src/mcp.cpp
  third_party/md4c/md4c.c
)
target_include_directories(synapse_core PUBLIC src)
target_include_directories(synapse_core SYSTEM PUBLIC third_party ${ORT_DIR}/include)
target_link_libraries(synapse_core PUBLIC SQLite::SQLite3 Threads::Threads ${ONNXRUNTIME_LIB})
target_compile_options(synapse_core PRIVATE -Wall -Wextra)
set_target_properties(synapse_core PROPERTIES POSITION_INDEPENDENT_CODE ON)

add_executable(synapse src/main.cpp)
target_link_libraries(synapse PRIVATE synapse_core)
set_target_properties(synapse PROPERTIES BUILD_RPATH ${ORT_DIR}/lib INSTALL_RPATH ${ORT_DIR}/lib)

add_executable(tokenize tools/tokenize.cpp)
target_link_libraries(tokenize PRIVATE synapse_core)
set_target_properties(tokenize PROPERTIES BUILD_RPATH ${ORT_DIR}/lib)

enable_testing()
add_executable(synapse_tests tests/tests.cpp)
target_link_libraries(synapse_tests PRIVATE synapse_core)
set_target_properties(synapse_tests PROPERTIES BUILD_RPATH ${ORT_DIR}/lib)
add_test(NAME synapse_tests COMMAND synapse_tests)
