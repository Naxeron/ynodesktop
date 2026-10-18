#include <iostream>
#include <stdlib.h>
#include <lcf/ldb/reader.h>
#include <lcf/rpg/database.h>

int main() {
    auto db = lcf::LDB_Reader::Load("maps/RPG_RT.ldb", "");
    if (!db) { std::cout << "Failed\n"; exit(1); }
    std::cout << "Map 224 Name: " << db->treemap.maps[224].name << "\n";
    std::cout << "Map 7 Name: " << db->treemap.maps[7].name << "\n";
    std::cout << "Map 2 Name: " << db->treemap.maps[2].name << "\n";
    exit(0);
}
