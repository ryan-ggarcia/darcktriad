#include <stdio.h>

int main(void) {
    int numero;
    if (scanf("%d", &numero) != 1) {
        fprintf(stderr, "Digite um inteiro.\n");
        return 1;
    }
    printf("%d\n", numero * 2);
    return 0;
}
