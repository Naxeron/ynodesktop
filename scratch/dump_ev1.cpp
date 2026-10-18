#include <iostream>
#include <stdlib.h>
#include <lcf/lmu/reader.h>
#include <lcf/rpg/map.h>

int main() {
    auto map = lcf::LMU_Reader::Load("Map0224.lmu", "");
    for (const auto& ev : map->events) {
        if (ev.ID == 1) {
            std::cout << "Event 1 Name: " << ev.name << "\n";
            for (const auto& page : ev.pages) {
                std::cout << "  Page Trigger: " << page.trigger << "\n";
                for (const auto& cmd : page.event_commands) {
                    std::cout << "    Code " << cmd.code << "\n";
                }
            }
        }
    }
    exit(0);
}
