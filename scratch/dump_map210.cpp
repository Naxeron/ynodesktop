#include <iostream>
#include <stdlib.h>
#include <lcf/lmu/reader.h>
#include <lcf/rpg/map.h>

int main() {
    auto map = lcf::LMU_Reader::Load("scratch/maps/Map0210.lmu", "");
    for (const auto& ev : map->events) {
        std::cout << "Event ID: " << ev.ID << " Name: " << ev.name << "\n";
    }
    exit(0);
}
