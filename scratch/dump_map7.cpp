#include <iostream>
#include <stdlib.h>
#include <lcf/lmu/reader.h>
#include <lcf/rpg/map.h>

int main() {
    auto map = lcf::LMU_Reader::Load("scratch/Map0007.lmu", "");
    if (!map) {
        std::cout << "Failed to load Map0007.lmu\n";
        exit(1);
    }
    std::cout << "Events: " << map->events.size() << "\n";
    for (const auto& ev : map->events) {
        std::cout << "Event ID: " << ev.ID << "\n";
        for (const auto& page : ev.pages) {
            std::cout << "  Page\n";
            for (const auto& cmd : page.event_commands) {
                std::cout << "    Code: " << cmd.code << "\n";
            }
        }
    }
    exit(0);
}
