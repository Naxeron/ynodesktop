#include <iostream>
#include <stdlib.h>
#include <lcf/lmu/reader.h>
#include <lcf/rpg/map.h>

int main() {
    auto map = lcf::LMU_Reader::Load("scratch/Map0224.lmu", "");
    for (const auto& ev : map->events) {
        std::cout << "Event ID: " << ev.ID << " Name: " << ev.name << " x:" << ev.x << " y:" << ev.y << "\n";
    }
    exit(0);
}
