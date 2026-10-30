var linha = Console.ReadLine() ?? "";
var letras = linha.ToCharArray();
Array.Reverse(letras);
Console.WriteLine(new string(letras));
