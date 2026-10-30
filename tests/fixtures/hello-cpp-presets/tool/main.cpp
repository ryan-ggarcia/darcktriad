#include <cstdlib>
#include <iostream>

#include "soma.h"

int main(int argc, char** argv) {
    int total = 0;
    for (int i = 1; i < argc; ++i) {
        total = soma(total, std::atoi(argv[i]));
    }
    std::cout << total << '\n';
    return 0;
}
