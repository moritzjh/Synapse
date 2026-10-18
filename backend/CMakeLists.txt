cmake_minimum_required(VERSION 3.20)
project(synapse_backend CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
set(CMAKE_CXX_FLAGS_RELEASE "-O3")

find_package(SQLite3 REQUIRED)
find_package(Threads REQUIRED)

add_executable(synapse
  src/main.cpp
  src/db.cpp
  src/note_store.cpp
  src/wikilinks.cpp
)
target_include_directories(synapse PRIVATE src third_party)
target_link_libraries(synapse PRIVATE SQLite::SQLite3 Threads::Threads)
target_compile_options(synapse PRIVATE -Wall -Wextra)
