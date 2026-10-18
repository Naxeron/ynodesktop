#include <iostream>
#include <lcf/lmu/reader.h>
#include <lcf/rpg/map.h>

int main(int argc, char** argv) {
    if (argc < 2) return 1;
    auto map = lcf::LMU_Reader::Load(argv[1], "");
    if (!map) {
        std::cerr << "Failed to load" << std::endl;
        return 1;
    }
    std::cout << "Map events: " << map->events.size() << std::endl;
    return 0;
}
