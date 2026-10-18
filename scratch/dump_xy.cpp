#include <iostream>
#include <stdlib.h>
#include <lcf/lmu/reader.h>
#include <lcf/rpg/map.h>

int main() {
    auto map = lcf::LMU_Reader::Load("maps/Map0224.lmu", "");
    for (const auto& ev : map->events) {
        std::cout << "Event ID: " << ev.ID << " Name: " << ev.name << " X: " << ev.x << " Y: " << ev.y << "\n";
    }
    exit(0);
}
