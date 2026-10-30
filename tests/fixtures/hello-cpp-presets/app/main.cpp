#include <iostream>
#include <string>

#include "soma.h"

int main() {
    std::string mensagem = "2 + 3 = " + std::to_string(soma(2, 3));
    std::cout << mensagem << '\n';
    return 0;
}
