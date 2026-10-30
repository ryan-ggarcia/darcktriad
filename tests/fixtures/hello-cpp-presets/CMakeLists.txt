cmake_minimum_required(VERSION 3.20)
project(hello CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

add_library(core STATIC core/soma.cpp)
target_include_directories(core PUBLIC core)

add_executable(app app/main.cpp)
target_link_libraries(app PRIVATE core)

add_executable(tool tool/main.cpp)
target_link_libraries(tool PRIVATE core)
